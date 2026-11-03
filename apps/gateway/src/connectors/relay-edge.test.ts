import { EventEmitter } from 'node:events';

import { isAdapterError } from '@twring/agent-adapter';
import {
  claimResponseSchema,
  MAX_RELAY_CHANNELS,
  NATIVE_PROTOCOL,
  pairingResponseSchema,
  RELAY_CLOSE,
  RELAY_PROTOCOL,
  type AgentEvent,
  type LocalAgent,
  type UserTurn,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';

import { targetAgentFactory } from '../agents/service';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { ConnectorHub, OfflineSocket, RelayChannelSocket } from './hub';
import { PairingBook, PAIRING_TTL_MS } from './pairing';
import { FAKE_AGENTS, startFakeConnector } from './testing';

/**
 * Relay edge cases (ADR-023): reconnects, races, stray frames, limits. The hub-level cases drive a
 * scripted socket so the timing is exact; the end-to-end ones use the real gateway and relay.
 */

const CONNECTOR = `con_${'a'.repeat(20)}`;
const IDENTITY = { connectorId: CONNECTOR, userId: 'alice', name: 'Laptop' };

/** The slice of a `ws` socket the hub uses, scripted. */
class ScriptedSocket extends EventEmitter {
  readonly sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  terminated = false;
  pings = 0;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code: number): void {
    if (this.closedWith !== undefined || this.terminated) return;
    this.closedWith = code;
    queueMicrotask(() => this.emit('close', code));
  }
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    queueMicrotask(() => this.emit('close', 1006));
  }
  ping(): void {
    this.pings += 1;
  }
  /** A frame from the connector. */
  frame(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }
  hello(agents: LocalAgent[] = FAKE_AGENTS): void {
    this.frame({
      type: 'connector.hello',
      protocol: RELAY_PROTOCOL,
      agent_protocol: NATIVE_PROTOCOL,
      agents,
    });
  }
  types(): unknown[] {
    return this.sent.map((m) => m.type);
  }
}

const asWs = (socket: ScriptedSocket) => socket as unknown as WebSocket;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const hubs: ConnectorHub[] = [];
function hub(options: ConstructorParameters<typeof ConnectorHub>[0] = {}) {
  const h = new ConnectorHub(options);
  hubs.push(h);
  return h;
}

async function readyConnector(h: ConnectorHub) {
  const ws = new ScriptedSocket();
  h.accept(asWs(ws), IDENTITY);
  ws.hello();
  await tick();
  expect(h.isOnline('alice', CONNECTOR)).toBe(true);
  return ws;
}

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) h.closeAll();
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway(options: Parameters<typeof startConnectorGateway>[0] = {}) {
  const g = await startConnectorGateway(options);
  gateways.push(g);
  return g;
}

const turn = (turnId: string): UserTurn => ({
  callId: 'call_1',
  sessionId: 'sess_1',
  turnId,
  role: 'user',
  text: 'Hello?',
  startedAt: new Date().toISOString(),
  committedAt: new Date().toISOString(),
});

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function relayAdapter(g: ConnectorGateway, user: string, connectorId: string) {
  return targetAgentFactory(
    {
      protocol: 'cord-connector',
      url: `cord-connector://${connectorId}/claude-code`,
      userId: user,
    },
    { env: 'development', connectors: g.hub },
  )('call_1');
}

describe('connector hub: handshake races', () => {
  it('a socket replaced while its hello is being recorded never becomes ready', async () => {
    const first = deferred<boolean>();
    let calls = 0;
    const h = hub({
      onHello: () => {
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve(true);
      },
    });
    const a = new ScriptedSocket();
    h.accept(asWs(a), IDENTITY);
    a.hello();
    const b = new ScriptedSocket();
    h.accept(asWs(b), IDENTITY);
    expect(a.closedWith).toBe(RELAY_CLOSE.replaced);
    b.hello();
    await tick();
    first.resolve(true);
    await tick();
    expect(a.types()).not.toContain('connector.ready');
    expect(b.types()).toEqual(['connector.ready']);
    expect(h.isOnline('alice', CONNECTOR)).toBe(true);
    // The old socket's late close does not take the new one offline.
    await tick();
    expect(h.isOnline('alice', CONNECTOR)).toBe(true);
  });

  it('a connector revoked while its hello is being recorded is closed as revoked', async () => {
    const h = hub({ onHello: () => Promise.resolve(false) });
    const ws = new ScriptedSocket();
    h.accept(asWs(ws), IDENTITY);
    ws.hello();
    await tick();
    expect(ws.closedWith).toBe(RELAY_CLOSE.revoked);
    expect(h.isOnline('alice', CONNECTOR)).toBe(false);
  });

  it('closes a socket that never says hello', async () => {
    const h = hub({ helloTimeoutMs: 20 });
    const ws = new ScriptedSocket();
    h.accept(asWs(ws), IDENTITY);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ws.closedWith).toBe(RELAY_CLOSE.protocolError);
  });
});

describe('connector hub: channels', () => {
  it('ignores frames for channels it never opened, and frames after a channel closed', async () => {
    const h = hub();
    const ws = await readyConnector(h);
    ws.frame({ type: 'channel.message', channel: 'ch_neveropened', message: { type: 'pong' } });
    ws.frame({ type: 'channel.close', channel: 'ch_neveropened' });
    const socket = h.socketFor('alice', CONNECTOR, 'claude-code') as RelayChannelSocket;
    const delivered: string[] = [];
    socket.on('message', (data: Buffer) => delivered.push(data.toString('utf8')));
    let closes = 0;
    socket.on('close', () => (closes += 1));
    ws.frame({ type: 'channel.close', channel: socket.channel });
    ws.frame({ type: 'channel.message', channel: socket.channel, message: { type: 'late' } });
    ws.frame({ type: 'channel.close', channel: socket.channel });
    await tick();
    expect(delivered).toEqual([]);
    expect(closes).toBe(1);
    expect(ws.closedWith).toBeUndefined();
    expect(h.isOnline('alice', CONNECTOR)).toBe(true);
  });

  it("cannot deliver into another connector's channel", async () => {
    const h = hub();
    const alice = await readyConnector(h);
    const bob = new ScriptedSocket();
    h.accept(asWs(bob), { connectorId: `con_${'b'.repeat(20)}`, userId: 'bob', name: 'Bob' });
    bob.hello();
    await tick();
    const socket = h.socketFor('alice', CONNECTOR, 'claude-code') as RelayChannelSocket;
    const delivered: unknown[] = [];
    socket.on('message', (data: Buffer) => delivered.push(data));
    bob.frame({ type: 'channel.message', channel: socket.channel, message: { type: 'pong' } });
    bob.frame({ type: 'channel.close', channel: socket.channel });
    await tick();
    expect(delivered).toEqual([]);
    expect(socket.isClosed).toBe(false);
    expect(alice.closedWith).toBeUndefined();
  });

  it(`carries at most ${MAX_RELAY_CHANNELS} calls per computer, and frees a slot on close`, async () => {
    const h = hub();
    await readyConnector(h);
    const open = Array.from({ length: MAX_RELAY_CHANNELS }, () =>
      h.socketFor('alice', CONNECTOR, 'claude-code'),
    );
    expect(open.every((s) => s instanceof RelayChannelSocket)).toBe(true);
    expect(h.socketFor('alice', CONNECTOR, 'claude-code')).toBeInstanceOf(OfflineSocket);
    (open[0] as RelayChannelSocket).close();
    expect(h.socketFor('alice', CONNECTOR, 'claude-code')).toBeInstanceOf(RelayChannelSocket);
  });

  it('a malformed, binary, or oversized frame after hello closes the socket as a protocol error', async () => {
    for (const bad of [
      (ws: ScriptedSocket) => ws.emit('message', Buffer.from('{not json'), false),
      (ws: ScriptedSocket) => ws.emit('message', Buffer.from([1, 2, 3]), true),
      (ws: ScriptedSocket) => ws.emit('message', Buffer.alloc(2_000_000, 32), false),
      (ws: ScriptedSocket) => ws.frame({ type: 'channel.message', channel: 'BAD', message: {} }),
    ]) {
      const h = hub();
      const ws = await readyConnector(h);
      const socket = h.socketFor('alice', CONNECTOR, 'claude-code') as RelayChannelSocket;
      bad(ws);
      await tick();
      expect(ws.closedWith).toBe(RELAY_CLOSE.protocolError);
      expect(socket.isClosed).toBe(true);
    }
  });

  it('a missed heartbeat ends the socket and every channel on it, even mid-turn', async () => {
    const h = hub({ heartbeatMs: 15 });
    const ws = await readyConnector(h);
    const socket = h.socketFor('alice', CONNECTOR, 'claude-code') as RelayChannelSocket;
    const closed = new Promise((resolve) => socket.once('close', resolve));
    // Frames keep flowing, but no pong ever arrives.
    const flood = setInterval(
      () =>
        ws.frame({
          type: 'channel.message',
          channel: socket.channel,
          message: { type: 'text.delta' },
        }),
      2,
    );
    try {
      await closed;
    } finally {
      clearInterval(flood);
    }
    expect(ws.terminated).toBe(true);
    expect(h.isOnline('alice', CONNECTOR)).toBe(false);
  });

  it('a pong keeps the socket alive', async () => {
    // Pongs every 5 ms against a 100 ms heartbeat: wide enough that a busy machine (the whole
    // workspace testing in parallel) can't stall the pong timer past a heartbeat.
    const h = hub({ heartbeatMs: 100 });
    const ws = await readyConnector(h);
    const pong = setInterval(() => ws.emit('pong'), 5);
    await new Promise((resolve) => setTimeout(resolve, 450));
    clearInterval(pong);
    expect(ws.pings).toBeGreaterThan(2);
    expect(ws.terminated).toBe(false);
  });
});

describe('pairing codes', () => {
  it('forgets expired and finished codes on the next create (bounded memory)', () => {
    let now = 1_000_000;
    const book = new PairingBook(() => now);
    const old = Array.from({ length: 50 }, (_, i) => book.create(`user-${i}`));
    const claimed = book.take(old[0]!.code)!;
    book.completed(claimed, CONNECTOR);
    now += 3 * PAIRING_TTL_MS;
    book.create('someone-else');
    for (const pairing of old) expect(book.get(pairing.userId, pairing.pairingId)).toBeUndefined();
    expect(book.take(old[1]!.code)).toBeUndefined();
  });

  it('keeps at most three open codes per user, dropping the oldest', () => {
    const book = new PairingBook();
    const codes = Array.from({ length: 5 }, () => book.create('alice'));
    expect(book.get('alice', codes[0]!.pairingId)).toBeUndefined();
    expect(book.get('alice', codes[1]!.pairingId)).toBeUndefined();
    expect(book.take(codes[0]!.code)).toBeUndefined();
    expect(book.take(codes[4]!.code)).toBeDefined();
  });

  it('a code claimed twice at the same moment pairs exactly one computer', async () => {
    const g = await gateway();
    const pairing = pairingResponseSchema.parse(
      (await g.send('POST', '/v1/connectors/pairings', { user: 'alice' })).json(),
    );
    const claim = () =>
      g.send('POST', '/v1/connectors/claim', {
        body: { code: pairing.code, name: 'Laptop', agents: FAKE_AGENTS },
      });
    const results = await Promise.all([claim(), claim(), claim()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400, 400]);
    expect(await g.stores.connectors.list('alice')).toHaveLength(1);
    const winner = results.find((r) => r.statusCode === 201)!;
    expect(claimResponseSchema.parse(winner.json()).connector_id).toMatch(/^con_/);
  });
});

describe('relay end to end', () => {
  it('a computer that reconnects mid-call answers the next turn over a new channel', async () => {
    const g = await gateway();
    const { connectorId, token, connector } = await g.connect('alice');
    const adapter = await relayAdapter(g, 'alice', connectorId);
    await adapter.connect({ callId: 'c', sessionId: 's' }, AbortSignal.timeout(2000));
    await collect(adapter.sendTurn(turn('t_1'), AbortSignal.timeout(2000)));

    // The link drops (laptop Wi-Fi), and cord-connect comes back with the same token.
    connector.terminate();
    await connector.closed;
    const again = startFakeConnector({ url: g.socketUrl, token });
    await again.ready;

    const events = await collect(adapter.sendTurn(turn('t_2'), AbortSignal.timeout(2000)));
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(again.received.filter((r) => r.message.type === 'user.turn')).toHaveLength(1);
    // Turn 1 was never resent.
    expect(
      again.received.some((r) => r.message.type === 'user.turn' && r.message.turn_id === 't_1'),
    ).toBe(false);
    await adapter.close();
    again.terminate();
  });

  it('revoking a computer during a call fails the running turn and reports it offline after', async () => {
    const g = await gateway();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const { connectorId, connector } = await g.connect('alice', {
      script: async (t, ctx) => {
        ctx.send({ type: 'run.started', event_id: 'e0', turn_id: t.turn_id, seq: 0 });
        started();
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      },
    });
    const adapter = await relayAdapter(g, 'alice', connectorId);
    await adapter.connect({ callId: 'c', sessionId: 's' }, AbortSignal.timeout(2000));
    const turnDone = errorOf(collect(adapter.sendTurn(turn('t_1'), AbortSignal.timeout(3000))));
    await running;
    expect(
      (await g.send('DELETE', `/v1/connectors/${connectorId}`, { user: 'alice' })).statusCode,
    ).toBe(204);
    const error = await turnDone;
    expect(isAdapterError(error) && error.code).toBe('connection_lost');
    expect(await connector.closed).toBe(RELAY_CLOSE.revoked);
    const next = await errorOf(collect(adapter.sendTurn(turn('t_2'), AbortSignal.timeout(2000))));
    expect(isAdapterError(next) && next.code).toBe('agent_offline');
    await adapter.close();
  });

  it('a second copy with the same token takes over; the first is told it was replaced', async () => {
    const g = await gateway();
    const { connectorId, token, connector } = await g.connect('alice');
    const second = startFakeConnector({ url: g.socketUrl, token });
    await second.ready;
    expect(await connector.closed).toBe(RELAY_CLOSE.replaced);
    expect(g.hub.isOnline('alice', connectorId)).toBe(true);
    second.terminate();
    await second.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(g.hub.isOnline('alice', connectorId)).toBe(false);
  });

  it('refuses the upgrade of a revoked token even while under the rate limit', async () => {
    const g = await gateway({ socketRatePerMinute: 100 });
    const { connectorId, token } = await g.pair('alice');
    await g.send('DELETE', `/v1/connectors/${connectorId}`, { user: 'alice' });
    const refused = startFakeConnector({ url: g.socketUrl, token });
    await expect(refused.ready).rejects.toThrow(/401/);
  });
});

describe('a computer link opened from another place (self-hosted notice)', () => {
  const at = (address: string) => ({ ...IDENTITY, address });

  it('a replacing socket from another address tells the listener and logs connector_replaced', async () => {
    const warnings: Record<string, unknown>[] = [];
    const h = hub({ logger: { info: () => undefined, warn: (fields) => warnings.push(fields) } });
    const replaced: string[] = [];
    h.setReplacedListener((identity) => replaced.push(identity.connectorId));
    h.accept(asWs(new ScriptedSocket()), at('203.0.113.1'));
    h.accept(asWs(new ScriptedSocket()), at('198.51.100.7'));
    await tick();
    expect(replaced).toEqual([CONNECTOR]);
    expect(warnings).toEqual([{ event: 'connector_replaced', connector_id: CONNECTOR }]);
    expect(JSON.stringify(warnings)).not.toContain('198.51.100.7');
  });

  it('the same address reconnecting is not a notice', async () => {
    const h = hub();
    const replaced: string[] = [];
    h.setReplacedListener((identity) => replaced.push(identity.connectorId));
    h.accept(asWs(new ScriptedSocket()), at('203.0.113.1'));
    h.accept(asWs(new ScriptedSocket()), at('203.0.113.1'));
    await tick();
    expect(replaced).toEqual([]);
  });

  it('without a listener (hosted) nothing is logged', async () => {
    const warnings: unknown[] = [];
    const h = hub({ logger: { info: () => undefined, warn: (fields) => warnings.push(fields) } });
    h.accept(asWs(new ScriptedSocket()), at('203.0.113.1'));
    h.accept(asWs(new ScriptedSocket()), at('198.51.100.7'));
    await tick();
    expect(warnings).toEqual([]);
  });
});
