import type { AddressInfo } from 'node:net';

import { loadGatewayEnv } from '@twring/config/gateway';
import type { ThreadSocketFrame } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../app';
import { AuthError, createRequestAuth } from '../auth';
import { createMemoryStores } from '../store/repositories';
import { TEST_KEYS } from '../connectors/harness';
import { PhoneSocketHub } from './socket';
import type { ThreadService } from './service';
import type { SqliteThreadStore } from './store';

const openApps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of openApps.splice(0)) await app.close();
});

async function setup(
  options: {
    rate?: number;
    /** The per-address limit before sign-in; the per-person `rate` applies after it. */
    ipRate?: number;
    threads?: boolean;
    pingMs?: number;
    unansweredMs?: number;
    lifetimeMs?: number;
    me?: boolean;
  } = {},
) {
  const auth = createRequestAuth((request) => {
    const token = request.headers.authorization;
    if (token === 'Bearer alice' || token === 'Bearer bob') return Promise.resolve(token.slice(7));
    return Promise.reject(new AuthError(401, 'auth_invalid', 'Invalid token'));
  });
  const hub = new PhoneSocketHub({
    auth,
    ratePerMinute: options.rate ?? 20,
    ipRatePerMinute: options.ipRate ?? options.rate ?? 20,
    trustProxy: false,
    ...(options.pingMs !== undefined && { pingIntervalMs: options.pingMs }),
    ...(options.unansweredMs !== undefined && { unansweredPingMs: options.unansweredMs }),
    ...(options.lifetimeMs !== undefined && { lifetimeMs: options.lifetimeMs }),
  });
  const stores = createMemoryStores(TEST_KEYS);
  const app = buildApp({
    env: loadGatewayEnv(gatewayEnvFixture()),
    auth,
    ...(options.me && {
      agents: { stores, policy: { env: 'development' as const }, writeRatePerMinute: 30 },
      me: { deleteRatePerMinute: 3 },
    }),
    ...(options.threads !== false && {
      threads: {
        service: { deleteAllForUser: () => Promise.resolve(0) } as unknown as ThreadService,
        store: {} as SqliteThreadStore,
        writeRatePerMinute: 30,
        readRatePerMinute: 120,
        messagesPerDay: 500,
        socketHub: hub,
      },
    }),
  });
  openApps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const url = (path = '/v1/me/socket') => `ws://127.0.0.1:${port}${path}`;
  const connect = (token = 'alice', autoPong = true) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url(), { headers: { Authorization: `Bearer ${token}` }, autoPong });
      sockets.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  const rejected = (path: string, token?: string) =>
    new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url(path), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      ws.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      ws.once('error', reject);
    });
  return { app, hub, url, connect, rejected };
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', resolve));
}
function message(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    ws.once('message', (data) => {
      const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.from(data).toString('utf8');
      resolve(JSON.parse(text));
    }),
  );
}
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('phone socket', () => {
  // The HTTP server waits for every upgraded socket before it closes: phones still connected held
  // production restarts until the 45 s kill.
  it('shutting down closes connected phones at once instead of waiting for them', async () => {
    const { app, connect } = await setup({ pingMs: 60_000 });
    const ws = await connect();
    const gone = closed(ws);
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(3_000);
    await gone;
  }, 40_000);

  it('rejects missing and bad tokens, unknown paths, and excessive upgrades', async () => {
    const { rejected } = await setup({ rate: 2 });
    expect(await rejected('/v1/me/socket')).toBe(401);
    expect(await rejected('/v1/me/socket', 'bad')).toBe(401);
    expect(await rejected('/unknown')).toBe(404);
    expect(await rejected('/v1/me/socket', 'alice')).toBe(429);
  });

  it('people on one address each get their own connect budget (review finding 6)', async () => {
    const { url } = await setup({ rate: 1, ipRate: 10 });
    const attempt = (token: string) =>
      new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(url('/v1/me/socket'), {
          headers: { Authorization: `Bearer ${token}` },
        });
        ws.once('open', () => {
          ws.close();
          resolve(101);
        });
        ws.on('unexpected-response', (_request, response) => {
          resolve(response.statusCode ?? 0);
          response.resume();
        });
        ws.once('error', reject);
      });
    expect(await attempt('alice')).toBe(101);
    expect(await attempt('bob')).toBe(101);
    expect(await attempt('alice')).toBe(429);
  });

  it('publishes only to the matching user and tracks focus across sockets', async () => {
    const { hub, connect } = await setup();
    const a = await connect();
    const a2 = await connect();
    const b = await connect('bob');
    let bobMessages = 0;
    b.on('message', () => bobMessages++);
    const frame: ThreadSocketFrame = { type: 'thread.cleared', agent_id: `agt_${'a'.repeat(20)}` };
    const gotA = message(a);
    const gotA2 = message(a2);
    hub.publish('alice', frame);
    expect(await gotA).toEqual(frame);
    expect(await gotA2).toEqual(frame);
    await tick();
    expect(bobMessages).toBe(0);
    expect(b.readyState).toBe(WebSocket.OPEN);
    expect(hub.isFocused('alice', frame.agent_id)).toBe(false);
    a.send(JSON.stringify({ type: 'focus', agent_id: frame.agent_id }));
    await tick();
    expect(hub.isFocused('alice', frame.agent_id)).toBe(true);
    const otherAgent = `agt_${'b'.repeat(20)}`;
    a.send(JSON.stringify({ type: 'focus', agent_id: otherAgent }));
    await tick();
    expect(hub.isFocused('alice', frame.agent_id)).toBe(false);
    expect(hub.isFocused('alice', otherAgent)).toBe(true);
    a.send(JSON.stringify({ type: 'focus', agent_id: null }));
    a2.send(JSON.stringify({ type: 'focus', agent_id: frame.agent_id }));
    await tick();
    expect(hub.isFocused('alice', frame.agent_id)).toBe(true);
    a2.send(JSON.stringify({ type: 'focus', agent_id: null }));
    await tick();
    expect(hub.isFocused('alice', frame.agent_id)).toBe(false);
    expect(hub.isFocused('bob', frame.agent_id)).toBe(false);
  });

  it('evicts the oldest, ignores malformed text, and closes on binary', async () => {
    const { connect, hub } = await setup();
    const first = await connect();
    await connect();
    await connect();
    const firstClosed = closed(first);
    const newest = await connect();
    expect(await firstClosed).toBe(4409);
    newest.send('{broken');
    newest.send(JSON.stringify({ type: 'unknown' }));
    await tick();
    expect(newest.readyState).toBe(WebSocket.OPEN);
    expect(hub.isFocused('alice', `agt_${'a'.repeat(20)}`)).toBe(false);
    const binaryClosed = closed(newest);
    newest.send(Buffer.from('binary'));
    expect(await binaryClosed).toBe(1003);
  });

  it('evicts a socket that missed its ping before a live one', async () => {
    const { connect } = await setup({ pingMs: 200, unansweredMs: 50 });
    const oldest = await connect();
    const lost = await connect('alice', false);
    await connect();
    // After one ping the lost socket has not answered; the next ping would end it.
    await tick(300);
    const lostClosed = closed(lost);
    await connect();
    expect(await lostClosed).toBe(4409);
    expect(oldest.readyState).toBe(WebSocket.OPEN);
  });

  it('pushes out the oldest, not a socket whose ping went out a moment ago', async () => {
    const { connect } = await setup({ pingMs: 200 });
    const oldest = await connect();
    // Its pong may still be on the way, so it is not counted as lost yet.
    const slow = await connect('alice', false);
    await connect();
    await tick(300);
    const oldestClosed = closed(oldest);
    await connect();
    expect(await oldestClosed).toBe(4409);
    expect(slow.readyState).toBe(WebSocket.OPEN);
  });

  it('stops counting a focused socket once its ping goes unanswered (finding 13)', async () => {
    const { connect, hub } = await setup({ pingMs: 100, unansweredMs: 50 });
    const lost = await connect('alice', false);
    const agentId = `agt_${'a'.repeat(20)}`;
    lost.send(JSON.stringify({ type: 'focus', agent_id: agentId }));
    await tick();
    expect(hub.isFocused('alice', agentId)).toBe(true);
    // The first ping goes out at 100 ms; 50 ms later it counts as unanswered.
    await tick(170);
    expect(lost.readyState).toBe(WebSocket.OPEN);
    expect(hub.isFocused('alice', agentId)).toBe(false);
  });

  it('confirms focus with a ping, terminating a silent socket and sharing a probe', async () => {
    const { connect, hub } = await setup({ pingMs: 60_000 });
    const agentId = `agt_${'a'.repeat(20)}`;
    expect(await hub.confirmFocused('alice', agentId, 100)).toBe(false);
    const live = await connect();
    live.send(JSON.stringify({ type: 'focus', agent_id: agentId }));
    await tick();
    let pings = 0;
    live.on('ping', () => pings++);
    const first = hub.confirmFocused('alice', agentId, 1_000);
    const second = hub.confirmFocused('alice', agentId, 1_000);
    expect(second).toBe(first);
    expect(await first).toBe(true);
    expect(pings).toBe(1);
    expect(hub.isFocused('alice', agentId)).toBe(true);

    const silent = await connect('bob', false);
    silent.send(JSON.stringify({ type: 'focus', agent_id: agentId }));
    await tick();
    const gone = closed(silent);
    const started = Date.now();
    expect(await hub.confirmFocused('bob', agentId, 100)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await gone).toBe(1006);
    expect(hub.isFocused('bob', agentId)).toBe(false);
  });

  it('waits as long as the heartbeat before cutting a slow focused socket', async () => {
    const { connect, hub } = await setup({ pingMs: 60_000, unansweredMs: 400 });
    const agentId = `agt_${'a'.repeat(20)}`;
    const slow = await connect('alice', false);
    slow.send(JSON.stringify({ type: 'focus', agent_id: agentId }));
    await tick();
    let settled = false;
    const probe = hub.confirmFocused('alice', agentId).then((result) => {
      settled = true;
      return result;
    });
    // A pong the heartbeat would still accept may arrive here, so the socket stays open.
    await tick(250);
    expect(settled).toBe(false);
    expect(slow.readyState).toBe(WebSocket.OPEN);
    expect(await probe).toBe(false);
  });

  it('terminates an unresponsive socket and expires a connection', async () => {
    const { connect } = await setup({ pingMs: 30, lifetimeMs: 200 });
    const idle = await connect('alice', false);
    const gone = closed(idle);
    expect(await Promise.race([gone, tick(500).then(() => -1)])).toBe(1006);
    const fresh = await connect();
    expect(await Promise.race([closed(fresh), tick(500).then(() => -1)])).toBe(4401);
  });

  it('closes sockets after Delete my data and leaves the path absent with threads off', async () => {
    const { app, connect } = await setup({ me: true });
    const ws = await connect();
    const gone = closed(ws);
    const result = await app.inject({
      method: 'DELETE',
      url: '/v1/me/data',
      headers: { authorization: 'Bearer alice' },
    });
    expect(result.statusCode).toBe(200);
    expect(await gone).toBe(4403);
    const disabled = await setup({ threads: false });
    expect(await disabled.rejected('/v1/me/socket', 'alice')).toBe(404);
  });
});
