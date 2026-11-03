import { randomBytes, randomUUID } from 'node:crypto';

import { AdapterError, type TwringAgentAdapter } from '@twring/agent-adapter';
import type { AgentEvent, ThreadSocketFrame, UserTurn } from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CredentialCipher, messageKeys } from '../store/cipher';
import type { AgentRecord } from '../store/repositories';
import { ThreadService, type ThreadTurnTimeouts } from './service';
import { SqliteThreadStore } from './store';

const A = `agt_${'a'.repeat(20)}`;
const B = `agt_${'b'.repeat(20)}`;
const rec = (id: string, userId: string): AgentRecord => ({
  id,
  user_id: userId,
  name: 'Agent',
  protocol: 'cord-rest',
  endpoint_url: 'https://example.com/agent',
  voice_id: 'flux-aura-en',
  status: 'ready',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});
const ev = (type: string, fields: object = {}): AgentEvent =>
  ({ type, event_id: randomUUID(), turn_id: 'agent-turn', ...fields }) as AgentEvent;
const never = () => new Promise<never>(() => undefined);

class Fake implements TwringAgentAdapter {
  readonly name = 'fake';
  readonly capabilities = {
    streamingText: true,
    cancellation: true,
    resumableStream: false,
    activityEvents: true,
    toolEvents: true,
    approvals: true,
    conversationResume: true,
    serverInitiatedCalls: false,
  };
  readonly turns: UserTurn[] = [];
  readonly cancels: string[] = [];
  closed = 0;
  connectImpl: (signal: AbortSignal) => Promise<void> = () => Promise.resolve();
  // eslint-disable-next-line @typescript-eslint/require-await -- default script needs no waiting
  streamImpl: (signal: AbortSignal) => AsyncIterable<AgentEvent> = async function* () {
    yield ev('text.delta', { message_id: 'm', delta: 'ok' });
    yield ev('done', { status: 'completed' });
  };
  connect(_o: unknown, signal: AbortSignal): Promise<void> {
    return this.connectImpl(signal);
  }
  sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.turns.push(turn);
    return this.streamImpl(signal);
  }
  cancelTurn(_turnId: string, reason: string): Promise<void> {
    this.cancels.push(reason);
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed++;
    return Promise.resolve();
  }
}
/** Resolves when `release` settles or the signal aborts. */
const hang = (signal: AbortSignal, release: Promise<unknown> = never()): Promise<void> =>
  Promise.race([
    release.then(() => undefined),
    new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    ),
  ]);

const stores: SqliteThreadStore[] = [];
const services: ThreadService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const s of services.splice(0)) s.stop();
  await new Promise((r) => setTimeout(r, 10));
  for (const st of stores.splice(0)) await st.close();
});

function setup(
  opts: {
    timeouts?: Partial<ThreadTurnTimeouts>;
    configure?: (a: Fake) => void;
    agentsGet?: (userId: string, id: string) => Promise<AgentRecord | undefined>;
  } = {},
) {
  const store = new SqliteThreadStore(
    ':memory:',
    new CredentialCipher(
      messageKeys({ currentVersion: 1, keys: new Map([[1, randomBytes(32).toString('base64')]]) }),
    ),
  );
  stores.push(store);
  const adapters: Fake[] = [];
  const frames: { user: string; frame: ThreadSocketFrame }[] = [];
  const state = { online: true, call: false };
  const factoryImpl: { fn: (a: Fake) => Promise<Fake> } = { fn: (a) => Promise.resolve(a) };
  const service = new ThreadService({
    store,
    agents: { get: opts.agentsGet ?? ((u, id) => Promise.resolve(rec(id, u))) },
    agentFactory: () => () => {
      const a = new Fake();
      opts.configure?.(a);
      adapters.push(a);
      return factoryImpl.fn(a);
    },
    agentStatus: () => (state.online ? 'online' : 'offline'),
    hasLiveCallToAgent: () => state.call,
    notify: (user, frame) => frames.push({ user, frame }),
    timeouts: { firstEventMs: 50, idleMs: 50, connectMs: 50, totalMs: 1_000, ...opts.timeouts },
  });
  services.push(service);
  return { store, service, adapters, frames, state, factoryImpl };
}
const send = (s: ThreadService, text = 'hi', agent = A, user = 'u1', clientId = randomUUID()) =>
  s.send(user, agent, { clientId, text });
const msgs = (st: SqliteThreadStore, agent = A, user = 'u1') =>
  st
    .listMessages(user, agent, { limit: 100 })
    .then((p) => [...p.messages].sort((a, b) => a.seq - b.seq));
const userRows = async (st: SqliteThreadStore, agent = A, user = 'u1') =>
  (await msgs(st, agent, user)).filter((m) => m.kind === 'user_text');
const statusOf = async (st: SqliteThreadStore, i = 0, agent = A, user = 'u1') => {
  const row = (await userRows(st, agent, user))[i];
  return row?.kind === 'user_text' ? row.status : undefined;
};
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('condition not reached');
}
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('ThreadService edge cases', () => {
  describe('lifecycle and leaks', () => {
    it('concurrent start() calls leave a single interval that stop() clears', async () => {
      vi.useFakeTimers();
      const t = setup();
      await Promise.all([t.service.start(), t.service.start()]);
      t.service.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stop() called while start() is still awaiting does not leave an interval', async () => {
      vi.useFakeTimers();
      const t = setup();
      const starting = t.service.start();
      t.service.stop();
      await starting;
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no timers after a turn that timed out', async () => {
      vi.useFakeTimers();
      const t = setup({
        configure: (a) => {
          a.streamImpl = async function* () {
            yield ev('text.delta', { message_id: 'm', delta: 'x' });
            await never();
          };
        },
      });
      await send(t.service);
      await vi.advanceTimersByTimeAsync(500);
      expect(await statusOf(t.store)).toBe('failed');
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('sweep robustness', () => {
    it('a sweep error is contained (never rejects into the interval or finally hooks)', async () => {
      const t = setup();
      vi.spyOn(t.store, 'queuedAgents').mockRejectedValueOnce(new Error('db busy'));
      await expect(t.service.sweep()).resolves.toBeUndefined();
    });

    it('one agent failing to load does not starve queued messages of other agents', async () => {
      const t = setup({
        agentsGet: (u, id) =>
          id === A ? Promise.reject(new Error('lookup failed')) : Promise.resolve(rec(id, u)),
      });
      t.state.online = false;
      await expect(send(t.service, 'a', A)).rejects.toThrow();
      await send(t.service, 'b', B);
      t.state.online = true;
      // A's queued row cannot be created through send(), so seed it directly.
      await t.store.appendUserMessage('u1', A, {
        clientId: randomUUID(),
        text: 'a',
        status: 'queued',
      });
      await t.service.sweep();
      await until(async () => (await statusOf(t.store, 0, B)) === 'answered');
    });

    it('a failing store write at the end of a turn does not strand the status or the adapter', async () => {
      const t = setup();
      vi.spyOn(t.store, 'appendMessage').mockRejectedValueOnce(new Error('disk full'));
      await send(t.service);
      await until(() => t.adapters.length === 1 && t.adapters[0]!.turns.length === 1);
      await settle();
      expect(['sent', 'working', 'queued']).not.toContain(await statusOf(t.store));
      expect(t.adapters[0]!.closed).toBeGreaterThan(0);
    });

    it('sweeps that overlap launch the queued message once', async () => {
      const t = setup();
      t.state.online = false;
      await send(t.service);
      t.state.online = true;
      await Promise.all([t.service.sweep(), t.service.sweep(), t.service.sweep()]);
      await until(async () => (await statusOf(t.store)) === 'answered');
      expect(t.adapters.flatMap((a) => a.turns)).toHaveLength(1);
    });

    it('sweep racing send keeps order and sends each message exactly once, one at a time', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const t = setup({
        configure: (a) => {
          a.streamImpl = async function* () {
            maxConcurrent = Math.max(maxConcurrent, ++concurrent);
            await new Promise((r) => setTimeout(r, 10));
            concurrent--;
            yield ev('done', { status: 'completed' });
          };
        },
      });
      t.state.online = false;
      await send(t.service, 'first');
      t.state.online = true;
      await Promise.all([t.service.sweep(), send(t.service, 'second'), t.service.sweep()]);
      await until(
        async () =>
          (await statusOf(t.store, 0)) === 'answered' &&
          (await statusOf(t.store, 1)) === 'answered',
      );
      expect(t.adapters.flatMap((a) => a.turns.map((x) => x.text))).toEqual(['first', 'second']);
      expect(maxConcurrent).toBe(1);
    });

    it('a requeue after an offline connect failure racing sweeps never double-sends', async () => {
      let n = 0;
      const t = setup({
        configure: (a) => {
          const mine = n++;
          a.connectImpl = () =>
            mine === 0 ? Promise.reject(new AdapterError('agent_offline')) : Promise.resolve();
        },
      });
      await send(t.service);
      for (let i = 0; i < 10; i++) void t.service.sweep();
      await until(async () => (await statusOf(t.store)) === 'queued');
      await t.service.sweep();
      await until(async () => (await statusOf(t.store)) === 'answered');
      expect(t.adapters.flatMap((a) => a.turns)).toHaveLength(1);
    });

    it('two sends with the same client_id start one turn', async () => {
      const t = setup();
      const clientId = randomUUID();
      const [x, y] = await Promise.all([
        send(t.service, 'one', A, 'u1', clientId),
        send(t.service, 'two', A, 'u1', clientId),
      ]);
      expect([x.created, y.created].sort()).toEqual([false, true]);
      await until(async () => (await statusOf(t.store)) === 'answered');
      expect(t.adapters.flatMap((a) => a.turns)).toHaveLength(1);
    });
  });

  describe('send racing a call', () => {
    it('does not run a turn if a call went live while the message was being stored', async () => {
      const t = setup();
      const original = t.store.appendUserMessage.bind(t.store);
      vi.spyOn(t.store, 'appendUserMessage').mockImplementation(async (...args) => {
        const out = await original(...args);
        t.state.call = true;
        return out;
      });
      const result = await send(t.service);
      await settle();
      expect(t.adapters.flatMap((a) => a.turns)).toHaveLength(0);
      expect(await statusOf(t.store)).toBe('queued');
      expect(result.message).toMatchObject({ status: 'queued' });
      t.state.call = false;
      await t.service.sweep();
      await until(async () => (await statusOf(t.store)) === 'answered');
    });
  });

  describe('connect problems', () => {
    it('a factory that hangs fails the turn with agent_timeout and closes the late adapter', async () => {
      const t = setup();
      let release!: () => void;
      t.factoryImpl.fn = (a) =>
        new Promise((r) => {
          release = () => r(a);
        });
      await send(t.service);
      await until(async () => (await statusOf(t.store)) === 'failed');
      expect((await userRows(t.store))[0]).toMatchObject({ error_code: 'agent_timeout' });
      release();
      await until(() => t.adapters[0]!.closed > 0);
      expect(t.adapters[0]!.turns).toHaveLength(0);
    });

    it('a factory that rejects fails the turn and frees the agent for the next message', async () => {
      const t = setup();
      let first = true;
      t.factoryImpl.fn = (a) => {
        if (first) {
          first = false;
          return Promise.reject(new Error('no credentials'));
        }
        return Promise.resolve(a);
      };
      await send(t.service, 'one');
      await until(async () => (await statusOf(t.store, 0)) === 'failed');
      await send(t.service, 'two');
      await until(async () => (await statusOf(t.store, 1)) === 'answered');
    });

    it('a factory that throws synchronously fails the turn', async () => {
      const t = setup();
      t.factoryImpl.fn = () => {
        throw new Error('boom');
      };
      await send(t.service);
      await until(async () => (await statusOf(t.store)) === 'failed');
    });

    it('stop during a hanging connect stops the message, never sends and closes the adapter', async () => {
      const t = setup({
        configure: (a) => {
          a.connectImpl = (signal) => hang(signal);
        },
        timeouts: { connectMs: 500 },
      });
      const { message } = await send(t.service);
      await until(() => t.adapters.length === 1);
      const stopped = await t.service.stop('u1', message.id);
      expect(stopped).toMatchObject({ status: 'stopped' });
      await until(() => t.adapters[0]!.closed > 0);
      await settle();
      expect(t.adapters[0]!.turns).toHaveLength(0);
      expect(await statusOf(t.store)).toBe('stopped');
    });

    it('a user cannot stop another user message', async () => {
      const t = setup({
        configure: (a) => {
          a.streamImpl = (signal) =>
            (async function* () {
              await hang(signal);
              yield ev('done', { status: 'completed' });
            })();
        },
        timeouts: { firstEventMs: 500, idleMs: 500 },
      });
      const { message } = await send(t.service, 'hi', A, 'u1');
      await until(() => t.adapters[0]?.turns.length === 1);
      expect(await t.service.stop('u2', message.id)).toBeUndefined();
      expect(t.adapters[0]!.cancels).toHaveLength(0);
    });
  });

  describe('timeouts', () => {
    it('times out an idle stream after the first event and cancels with timeout', async () => {
      const t = setup({
        timeouts: { firstEventMs: 500, idleMs: 40 },
        configure: (a) => {
          a.streamImpl = () =>
            (async function* () {
              yield ev('text.delta', { message_id: 'm', delta: 'part' });
              await never();
            })();
        },
      });
      await send(t.service);
      await until(async () => (await statusOf(t.store)) === 'failed');
      expect(t.adapters[0]!.cancels).toContain('timeout');
      expect((await userRows(t.store))[0]).toMatchObject({ error_code: 'agent_timeout' });
      expect((await msgs(t.store)).find((m) => m.kind === 'agent_text')).toMatchObject({
        text: 'part',
        partial: true,
      });
    });

    it('enforces the total timeout even when events keep trickling in', async () => {
      const t = setup({
        timeouts: { firstEventMs: 500, idleMs: 500, totalMs: 120 },
        configure: (a) => {
          a.streamImpl = () =>
            (async function* () {
              for (;;) {
                await new Promise((r) => setTimeout(r, 20));
                yield ev('text.delta', { message_id: 'm', delta: '.' });
              }
            })();
        },
      });
      await send(t.service);
      await until(async () => (await statusOf(t.store)) === 'failed');
      expect(t.adapters[0]!.cancels).toContain('timeout');
      expect((await userRows(t.store))[0]).toMatchObject({ error_code: 'agent_timeout' });
    });

    it('a hung connect() fails with agent_timeout without sending', async () => {
      const t = setup({
        configure: (a) => {
          a.connectImpl = () => never();
        },
      });
      await send(t.service);
      await until(async () => (await statusOf(t.store)) === 'failed');
      expect(t.adapters[0]!.turns).toHaveLength(0);
      expect(t.adapters[0]!.closed).toBeGreaterThan(0);
    });
  });

  describe('delete and clear while a turn is in flight', () => {
    const slow = (a: Fake) => {
      a.streamImpl = (signal) =>
        (async function* () {
          yield ev('text.delta', { message_id: 'm', delta: 'partial' });
          await hang(signal);
          yield ev('done', { status: 'completed' });
        })();
    };
    it('clear during connect writes nothing for the discarded turn and closes the adapter', async () => {
      const t = setup({
        configure: (a) => {
          a.connectImpl = (signal) => hang(signal);
        },
        timeouts: { connectMs: 500 },
      });
      await send(t.service);
      await until(() => t.adapters.length === 1);
      await t.service.clear('u1', A);
      await until(() => t.adapters[0]!.closed > 0);
      await settle();
      expect(await msgs(t.store)).toEqual([]);
      expect(t.adapters[0]!.turns).toHaveLength(0);
    });

    it('deleteAgent during streaming leaves no thread behind and cancels the turn', async () => {
      const t = setup({ configure: slow, timeouts: { firstEventMs: 500, idleMs: 500 } });
      await send(t.service);
      await until(() => t.adapters[0]?.turns.length === 1);
      await t.service.deleteAgent('u1', A);
      await until(() => t.adapters[0]!.closed > 0);
      await settle();
      expect(await t.store.listThreads('u1')).toEqual([]);
      expect(t.adapters[0]!.cancels).toContain('superseded');
    });

    it('clear after the turn is done does not resurrect messages', async () => {
      const t = setup();
      await send(t.service);
      await until(async () => (await statusOf(t.store)) === 'answered');
      await t.service.clear('u1', A);
      await settle();
      expect(await msgs(t.store)).toEqual([]);
    });

    it('a message queued behind a cleared running turn is removed, not sent', async () => {
      const t = setup({ configure: slow, timeouts: { firstEventMs: 500, idleMs: 500 } });
      await send(t.service, 'one');
      await until(() => t.adapters[0]?.turns.length === 1);
      await send(t.service, 'two');
      await t.service.clear('u1', A);
      await settle();
      await t.service.sweep();
      await settle();
      expect(t.adapters.flatMap((a) => a.turns.map((x) => x.text))).toEqual(['one']);
      expect(await msgs(t.store)).toEqual([]);
    });
  });

  describe('isolation', () => {
    it('same agent id for two users runs in parallel and frames never cross users', async () => {
      const t = setup({
        configure: (a) => {
          a.streamImpl = (signal) =>
            (async function* () {
              yield ev('text.delta', { message_id: 'm', delta: 'reply' });
              await hang(signal, new Promise((r) => setTimeout(r, 60)));
              yield ev('done', { status: 'completed' });
            })();
        },
        timeouts: { firstEventMs: 500, idleMs: 500 },
      });
      await Promise.all([
        send(t.service, 'secret-u1', A, 'u1'),
        send(t.service, 'secret-u2', A, 'u2'),
      ]);
      await until(() => t.adapters.length === 2 && t.adapters.every((a) => a.turns.length === 1));
      await until(
        async () =>
          (await statusOf(t.store, 0, A, 'u1')) === 'answered' &&
          (await statusOf(t.store, 0, A, 'u2')) === 'answered',
      );
      for (const { user, frame } of t.frames) {
        const json = JSON.stringify(frame);
        if (user === 'u1') expect(json).not.toContain('secret-u2');
        if (user === 'u2') expect(json).not.toContain('secret-u1');
      }
      expect(new Set(t.frames.map((f) => f.user))).toEqual(new Set(['u1', 'u2']));
    });

    it('expired queued messages notify only their owner', async () => {
      const t = setup();
      t.state.online = false;
      await send(t.service, 'x1', A, 'u1');
      await send(t.service, 'x2', A, 'u2');
      vi.spyOn(t.store, 'expireQueued').mockImplementation(async () => {
        const out: Awaited<ReturnType<SqliteThreadStore['expireQueued']>> = [];
        for (const u of ['u1', 'u2']) {
          const [m] = await t.store.queuedMessages(u, A);
          if (m) out.push((await t.store.updateUserMessage(u, m.id, { status: 'expired' }))!);
        }
        return out;
      });
      t.frames.length = 0;
      await t.service.sweep();
      expect(t.frames).toHaveLength(2);
      for (const { user, frame } of t.frames) {
        if (frame.type !== 'message.upserted' || frame.message.kind !== 'user_text') continue;
        expect(frame.message.text).toBe(user === 'u1' ? 'x1' : 'x2');
      }
    });
  });
});
