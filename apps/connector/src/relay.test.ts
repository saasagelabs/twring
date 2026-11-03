import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RELAY_CLOSE, type AgentEvent } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { checkServerUrl, loadConfig, saveConfig, socketUrl, type ConnectorConfig } from './config';
import { EventQueue, type LocalAgentAdapter, type LocalAgentEvent } from './events';
import { RECONNECT_DELAYS_MS, RelayClient, type RelayStatus } from './relay';
import { AgentPool } from './pool';
import { ChannelSession } from './session';

const TOKEN = `cct_${'a'.repeat(43)}`;
const AGENTS = [{ id: 'echo', label: 'Echo', kind: 'command' as const }];

/** Answers with the turn text, or waits until cancelled when the text is "wait". */
class EchoAdapter implements LocalAgentAdapter {
  closed = false;
  async *sendTurn(text: string, signal: AbortSignal): AsyncIterable<LocalAgentEvent> {
    if (text === 'wait') {
      const queue = new EventQueue<LocalAgentEvent>();
      signal.addEventListener('abort', () => queue.end(), { once: true });
      queue.push({ type: 'text', text: 'Working on it' });
      yield* queue;
      return;
    }
    yield { type: 'text', text };
  }
  close(): void {
    this.closed = true;
  }
}

const servers: WebSocketServer[] = [];
const clients: RelayClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          for (const c of s.clients) c.terminate();
          s.close(() => resolve());
        }),
    ),
  );
});

async function server(onConnection: (ws: WebSocket, auth: string | undefined) => void) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(wss);
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (ws, req) => onConnection(ws, req.headers.authorization));
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/connectors/socket`;
}

function client(
  url: string,
  statuses: RelayStatus[],
  extra: Partial<ConstructorParameters<typeof RelayClient>[0]> = {},
) {
  const c = new RelayClient({
    url,
    token: TOKEN,
    agents: AGENTS,
    pool: new AgentPool({
      dir: 'nonexistent-relay-test-config',
      createAdapter: (id) => (id === 'echo' ? new EchoAdapter() : undefined),
    }),
    onBackgroundResult: () => undefined,
    onStatus: (s) => statuses.push(s),
    delaysMs: [10, 20, 40],
    random: () => 0,
    ...extra,
  });
  clients.push(c);
  return c;
}

const waitFor = async (check: () => boolean) => {
  const until = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('relay client', () => {
  it('uses features from the latest ready frame after reconnect', async () => {
    let connections = 0;
    const url = await server((ws) => {
      connections++;
      const current = connections;
      ws.on('message', () => {
        ws.send(
          JSON.stringify({
            type: 'connector.ready',
            protocol: 'cord-relay/1',
            connector_id: `con_${'a'.repeat(20)}`,
            name: 'Laptop',
            ...(current === 1 && { features: ['messages'] }),
          }),
        );
        if (current === 1) setTimeout(() => ws.close(), 10);
      });
    });
    const statuses: RelayStatus[] = [];
    const c = client(url, statuses);
    expect(c.supports('messages')).toBe(false);
    c.start();
    await waitFor(() => c.supports('messages'));
    await waitFor(
      () => connections === 2 && statuses.filter((s) => s.kind === 'connected').length === 2,
    );
    expect(c.supports('messages')).toBe(false);
  });
  it('authenticates, says hello, and answers a call over a channel', async () => {
    const frames: Record<string, unknown>[] = [];
    let auth: string | undefined;
    const url = await server((ws, header) => {
      auth = header;
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === 'connector.hello') {
          ws.send(
            JSON.stringify({
              type: 'connector.ready',
              protocol: 'cord-relay/1',
              connector_id: `con_${'a'.repeat(20)}`,
              name: 'Laptop',
            }),
          );
          ws.send(JSON.stringify({ type: 'channel.open', channel: 'ch_1', agent: 'echo' }));
          const msg = (message: unknown) =>
            ws.send(JSON.stringify({ type: 'channel.message', channel: 'ch_1', message }));
          msg({
            type: 'session.hello',
            protocol: 'cord-agent/1',
            session_id: 's',
            call_id: 'c',
            capabilities_requested: [],
          });
          msg({
            type: 'user.turn',
            session_id: 's',
            turn_id: 't1',
            text: 'Hello back',
            started_at: 'x',
            committed_at: 'x',
          });
        }
      });
    });
    const statuses: RelayStatus[] = [];
    client(url, statuses).start();
    await waitFor(() =>
      frames.some((f) => (f.message as { type?: string } | undefined)?.type === 'done'),
    );
    expect(auth).toBe(`Bearer ${TOKEN}`);
    expect(frames[0]).toMatchObject({
      type: 'connector.hello',
      protocol: 'cord-relay/1',
      agent_protocol: 'cord-agent/1',
      agents: AGENTS,
    });
    expect(statuses).toContainEqual({ kind: 'connected', name: 'Laptop' });
    const inner = frames.flatMap((f) =>
      f.type === 'channel.message' ? [f.message as Record<string, unknown>] : [],
    );
    expect(inner[0]).toMatchObject({ type: 'session.ready', capabilities: { cancel: true } });
    expect(inner.map((m) => m.type)).toEqual([
      'session.ready',
      'run.started',
      'text.start',
      'text.delta',
      'text.end',
      'done',
    ]);
    expect(inner.find((m) => m.type === 'text.delta')?.delta).toBe('Hello back');
  });

  it("says it keeps scoped sessions, and a scoped call is not the owner's open channel", async () => {
    const scope = 'e'.repeat(32);
    const frames: Record<string, unknown>[] = [];
    const url = await server((ws) => {
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type !== 'connector.hello') return;
        ws.send(
          JSON.stringify({
            type: 'connector.ready',
            protocol: 'cord-relay/1',
            connector_id: `con_${'a'.repeat(20)}`,
            name: 'Laptop',
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'channel.open',
            channel: 'ch_1',
            agent: 'echo',
            session_scope: scope,
          }),
        );
      });
    });
    const c = client(url, []);
    c.start();
    await waitFor(() => c.hasOpenChannel('echo', scope));
    expect(frames[0]).toMatchObject({ features: ['scoped_sessions'] });
    expect(c.hasOpenChannel('echo')).toBe(false);
  });

  it('reconnects with backoff after a drop', async () => {
    let connections = 0;
    const url = await server((ws) => {
      connections += 1;
      if (connections < 3) ws.terminate();
      else
        ws.on('message', () =>
          ws.send(
            JSON.stringify({
              type: 'connector.ready',
              protocol: 'cord-relay/1',
              connector_id: `con_${'a'.repeat(20)}`,
              name: 'L',
            }),
          ),
        );
    });
    const statuses: RelayStatus[] = [];
    client(url, statuses).start();
    await waitFor(() => statuses.some((s) => s.kind === 'connected'));
    expect(connections).toBe(3);
    expect(statuses.filter((s) => s.kind === 'disconnected')).toEqual([
      { kind: 'disconnected', retryInMs: 10 },
      { kind: 'disconnected', retryInMs: 20 },
    ]);
  });

  it('stops for good when revoked, and on a refused token', async () => {
    const url = await server((ws) => ws.close(RELAY_CLOSE.revoked, 'revoked'));
    const statuses: RelayStatus[] = [];
    const c = client(url, statuses);
    c.start();
    await c.done;
    expect(statuses.at(-1)).toEqual({ kind: 'stopped', reason: 'revoked' });

    const refused = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_i, done) => done(false, 401),
    });
    servers.push(refused);
    await new Promise((resolve) => refused.once('listening', resolve));
    const statuses2: RelayStatus[] = [];
    const c2 = client(`ws://127.0.0.1:${(refused.address() as AddressInfo).port}/`, statuses2);
    c2.start();
    await c2.done;
    expect(statuses2.at(-1)).toEqual({ kind: 'stopped', reason: 'unauthorized' });
  });

  it('stops when another copy takes over (4409), and on 403', async () => {
    const url = await server((ws) => ws.close(RELAY_CLOSE.replaced, 'replaced'));
    const statuses: RelayStatus[] = [];
    const c = client(url, statuses);
    c.start();
    await c.done;
    expect(statuses.at(-1)).toEqual({ kind: 'stopped', reason: 'replaced' });

    const forbidden = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_i, done) => done(false, 403),
    });
    servers.push(forbidden);
    await new Promise((resolve) => forbidden.once('listening', resolve));
    const statuses2: RelayStatus[] = [];
    const c2 = client(`ws://127.0.0.1:${(forbidden.address() as AddressInfo).port}/`, statuses2);
    c2.start();
    await c2.done;
    expect(statuses2.at(-1)).toEqual({ kind: 'stopped', reason: 'unauthorized' });
  });

  it('keeps retrying on a protocol error, a rate limit, or a server error', async () => {
    let connections = 0;
    const url = await server((ws) => {
      connections += 1;
      ws.close(RELAY_CLOSE.protocolError, 'bad hello');
    });
    const statuses: RelayStatus[] = [];
    client(url, statuses).start();
    await waitFor(() => connections >= 3);
    expect(statuses.some((s) => s.kind === 'stopped')).toBe(false);

    for (const status of [429, 503]) {
      let attempts = 0;
      const busy = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        verifyClient: (_i, done) => {
          attempts += 1;
          done(false, status);
        },
      });
      servers.push(busy);
      await new Promise((resolve) => busy.once('listening', resolve));
      const s: RelayStatus[] = [];
      client(`ws://127.0.0.1:${(busy.address() as AddressInfo).port}/`, s).start();
      await waitFor(() => attempts >= 2);
      expect(s.some((x) => x.kind === 'stopped')).toBe(false);
    }
  });

  it('backs off to a ceiling, with jitter of at most 20% on top', async () => {
    let connections = 0;
    const url = await server((ws) => {
      connections += 1;
      ws.terminate();
    });
    const statuses: RelayStatus[] = [];
    client(url, statuses, { delaysMs: [1, 2, 4], random: () => 1 }).start();
    await waitFor(() => connections >= 6);
    const waits = statuses.flatMap((s) => (s.kind === 'disconnected' ? [s.retryInMs] : []));
    expect(waits.slice(0, 5)).toEqual([1, 2, 5, 5, 5]); // 4 ms + 20%, rounded
    expect(Math.max(...waits)).toBeLessThanOrEqual(5);
  });

  it('the default schedule never waits more than 36 s', () => {
    const last = RECONNECT_DELAYS_MS.at(-1)!;
    expect(last).toBe(30_000);
    expect(Math.round(last * 1.2)).toBe(36_000);
  });

  it('detaches a running turn when the link drops, and never resends it', async () => {
    const adapters: EchoAdapter[] = [];
    let connections = 0;
    let opened!: () => void;
    const channelOpen = new Promise<void>((resolve) => (opened = resolve));
    const url = await server((ws) => {
      connections += 1;
      ws.once('message', () => {
        ws.send(
          JSON.stringify({
            type: 'connector.ready',
            protocol: 'cord-relay/1',
            connector_id: `con_${'a'.repeat(20)}`,
            name: 'L',
          }),
        );
        if (connections > 1) return;
        ws.send(JSON.stringify({ type: 'channel.open', channel: 'ch_1', agent: 'echo' }));
        ws.send(
          JSON.stringify({
            type: 'channel.message',
            channel: 'ch_1',
            message: {
              type: 'user.turn',
              session_id: 's',
              turn_id: 't1',
              text: 'wait',
              started_at: 'x',
              committed_at: 'x',
            },
          }),
        );
        ws.on('message', (data: Buffer) => {
          const frame = JSON.parse(data.toString('utf8')) as { message?: { type?: string } };
          if (frame.message?.type === 'text.delta') {
            opened();
            ws.terminate();
          }
        });
      });
    });
    const statuses: RelayStatus[] = [];
    client(url, statuses, {
      pool: new AgentPool({
        dir: 'nonexistent-relay-test-config',
        createAdapter: () => {
          const a = new EchoAdapter();
          adapters.push(a);
          return a;
        },
      }),
    }).start();
    await channelOpen;
    await waitFor(() => connections >= 2);
    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.closed).toBe(false);
  });

  it('reconnects after a silent link', async () => {
    let connections = 0;
    const url = await server(() => {
      connections += 1; // Accepts, then says nothing at all.
    });
    client(url, [], { silenceTimeoutMs: 50 }).start();
    await waitFor(() => connections >= 2);
  });
});

describe('channel session', () => {
  it('cancels a running turn on turn.cancel and reports done: cancelled', async () => {
    const sent: Record<string, unknown>[] = [];
    const adapter = new EchoAdapter();
    const session = new ChannelSession({ adapter, send: (m) => sent.push(m) });
    session.handle({
      type: 'user.turn',
      session_id: 's',
      turn_id: 't1',
      text: 'wait',
      started_at: 'x',
      committed_at: 'x',
    });
    await waitFor(() => sent.some((m) => m.type === 'text.delta'));
    session.handle({ type: 'turn.cancel', turn_id: 't1', reason: 'barge_in' });
    await waitFor(() => sent.some((m) => m.type === 'done'));
    const events = sent as AgentEvent[];
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'cancelled', turn_id: 't1' });
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0)));
    session.close();
    expect(adapter.closed).toBe(false);
  });

  it('refuses a session for an agent this computer does not offer', () => {
    const sent: Record<string, unknown>[] = [];
    const session = new ChannelSession({ adapter: undefined, send: (m) => sent.push(m) });
    session.handle({
      type: 'session.hello',
      protocol: 'cord-agent/1',
      session_id: 's',
      call_id: 'c',
      capabilities_requested: [],
    });
    expect(sent).toEqual([{ type: 'session.error', code: 'agent_error' }]);
  });

  it('a turn cancelled while it waits for the previous one never reaches the agent', async () => {
    const sent: Record<string, unknown>[] = [];
    const texts: string[] = [];
    class RecordingAdapter extends EchoAdapter {
      override sendTurn(text: string, signal: AbortSignal): AsyncIterable<LocalAgentEvent> {
        texts.push(text);
        return super.sendTurn(text, signal);
      }
    }
    const session = new ChannelSession({
      adapter: new RecordingAdapter(),
      send: (m) => sent.push(m),
    });
    const userTurn = (turn_id: string, text: string) => ({
      type: 'user.turn',
      session_id: 's',
      turn_id,
      text,
      started_at: 'x',
      committed_at: 'x',
    });
    session.handle(userTurn('t1', 'wait'));
    await waitFor(() => sent.some((m) => m.type === 'text.delta'));
    session.handle(userTurn('t2', 'second')); // supersedes t1
    session.handle({ type: 'turn.cancel', turn_id: 't2', reason: 'barge_in' });
    session.handle(userTurn('t3', 'third'));
    await waitFor(() => sent.some((m) => m.type === 'done' && m.turn_id === 't3'));
    expect(texts).toEqual(['wait', 'third']);
    expect(sent.find((m) => m.type === 'done' && m.turn_id === 't1')).toMatchObject({
      status: 'cancelled',
    });
    session.close();
  });

  it('a cancel that arrives after the turn finished changes nothing', async () => {
    const sent: Record<string, unknown>[] = [];
    const session = new ChannelSession({ adapter: new EchoAdapter(), send: (m) => sent.push(m) });
    const userTurn = (turn_id: string) => ({
      type: 'user.turn',
      session_id: 's',
      turn_id,
      text: 'hi',
      started_at: 'x',
      committed_at: 'x',
    });
    session.handle(userTurn('t1'));
    await waitFor(() => sent.some((m) => m.type === 'done'));
    session.handle({ type: 'turn.cancel', turn_id: 't1', reason: 'barge_in' });
    session.handle(userTurn('t2'));
    await waitFor(() => sent.some((m) => m.type === 'done' && m.turn_id === 't2'));
    expect(sent.filter((m) => m.type === 'done').map((m) => m.status)).toEqual([
      'completed',
      'completed',
    ]);
    session.close();
    session.handle(userTurn('t3'));
    expect(sent.some((m) => m.turn_id === 't3')).toBe(false);
  });

  it('answers pings and ignores malformed frames', () => {
    const sent: Record<string, unknown>[] = [];
    const session = new ChannelSession({ adapter: new EchoAdapter(), send: (m) => sent.push(m) });
    session.handle({ type: 'user.turn' });
    session.handle({ type: 'ping', id: 'p1' });
    expect(sent).toEqual([{ type: 'pong', id: 'p1' }]);
  });
});

describe('config', () => {
  it('enforces https except for localhost', () => {
    expect(checkServerUrl('https://cord.example.com/').toString()).toBe(
      'https://cord.example.com/',
    );
    expect(socketUrl(checkServerUrl('https://cord.example.com'))).toBe(
      'wss://cord.example.com/v1/connectors/socket',
    );
    expect(socketUrl(checkServerUrl('http://localhost:8787'))).toBe(
      'ws://localhost:8787/v1/connectors/socket',
    );
    expect(() => checkServerUrl('http://cord.example.com')).toThrow(/https/);
    expect(() => checkServerUrl('http://192.168.1.5:8787')).toThrow(/https/);
    expect(() => checkServerUrl('https://user:pw@cord.example.com')).toThrow(/password/);
    // Names that only look local are not local.
    for (const lookalike of [
      'http://localhost.evil.example',
      'http://127.0.0.1.nip.io',
      'http://0.0.0.0:8787',
      'http://[::ffff:7f00:1]:8787',
      'ws://cord.example.com',
      'file:///etc/passwd',
    ]) {
      expect(() => checkServerUrl(lookalike)).toThrow();
    }
    expect(socketUrl(checkServerUrl('http://[::1]:8787'))).toBe(
      'ws://[::1]:8787/v1/connectors/socket',
    );
    expect(socketUrl(checkServerUrl('https://cord.example.com/base/?x=1#y'))).toBe(
      'wss://cord.example.com/base/v1/connectors/socket',
    );
  });

  it('a second pairing replaces the saved token; a damaged file says to pair again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-connect-'));
    try {
      const path = join(dir, 'config.json');
      const base: ConnectorConfig = {
        server: 'https://cord.example.com/',
        connector_id: `con_${'b'.repeat(20)}`,
        token: TOKEN,
        name: 'Laptop',
        agents: [
          { id: 'echo', label: 'Echo', kind: 'command', command: 'echo', args: [], cwd: dir },
        ],
      };
      await saveConfig(path, base);
      const second = {
        ...base,
        connector_id: `con_${'c'.repeat(20)}`,
        token: `cct_${'z'.repeat(43)}`,
      };
      await saveConfig(path, second);
      expect(await loadConfig(path)).toEqual(second);
      expect((await readdir(dir)).sort()).toEqual(['config.json']);

      await writeFile(path, '{"server": "https://cord.example.com/", "token": "cct_x"}', 'utf8');
      await expect(loadConfig(path)).rejects.toThrow(/Pair again/);
      await writeFile(path, 'not json', 'utf8');
      await expect(loadConfig(path)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('saves the token in a file only this user can read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-connect-'));
    try {
      const path = join(dir, 'nested', 'config.json');
      const config: ConnectorConfig = {
        server: 'https://cord.example.com/',
        connector_id: `con_${'b'.repeat(20)}`,
        token: TOKEN,
        name: 'Laptop',
        agents: [
          { id: 'echo', label: 'Echo', kind: 'command', command: 'echo', args: [], cwd: dir },
        ],
      };
      await saveConfig(path, config);
      expect(await loadConfig(path)).toEqual(config);
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
