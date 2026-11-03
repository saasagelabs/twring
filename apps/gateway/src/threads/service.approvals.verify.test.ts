import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TwringAgentAdapter } from '@twring/agent-adapter';
import {
  APPROVAL_HOLD_MS,
  type AgentEvent,
  type ThreadMessage,
  type ThreadSocketFrame,
  type UserTurn,
} from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CredentialCipher, messageKeys } from '../store/cipher';
import type { AgentRecord } from '../store/repositories';
import { ThreadService, type ThreadServiceError, type ThreadTurnTimeouts } from './service';
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
const approvalEvent = (id: string, title = 'Run the report') =>
  ev('approval.required', { approval_id: id, action: 'other', title, description: 'secret-desc' });

/** A push-driven adapter: the test decides when each event arrives and when the stream ends. */
class Driven implements TwringAgentAdapter {
  readonly name = 'driven';
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
  readonly decisions: [string, string][] = [];
  closed = 0;
  decideImpl: (approvalId: string, decision: string) => Promise<void> = () => Promise.resolve();
  private queue: (AgentEvent | Error | 'end')[] = [];
  private wake?: () => void;
  push(...items: (AgentEvent | Error | 'end')[]): void {
    this.queue.push(...items);
    this.wake?.();
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  async *sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.turns.push(turn);
    while (!signal.aborted) {
      const item = this.queue.shift();
      if (item === undefined) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        continue;
      }
      if (item === 'end') return;
      if (item instanceof Error) throw item;
      yield item;
    }
  }
  cancelTurn(): Promise<void> {
    return Promise.resolve();
  }
  decideApproval(_turnId: string, approvalId: string, decision: 'approve' | 'deny'): Promise<void> {
    this.decisions.push([approvalId, decision]);
    return this.decideImpl(approvalId, decision);
  }
  close(): Promise<void> {
    this.closed++;
    return Promise.resolve();
  }
}

const stores: SqliteThreadStore[] = [];
const services: ThreadService[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const s of services.splice(0)) s.stop();
  await new Promise((r) => setTimeout(r, 10));
  for (const st of stores.splice(0)) await st.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts: { timeouts?: Partial<ThreadTurnTimeouts>; path?: string } = {}) {
  const store = new SqliteThreadStore(
    opts.path ?? ':memory:',
    new CredentialCipher(
      messageKeys({ currentVersion: 1, keys: new Map([[1, randomBytes(32).toString('base64')]]) }),
    ),
  );
  stores.push(store);
  const adapters: Driven[] = [];
  const frames: ThreadSocketFrame[] = [];
  const service = new ThreadService({
    store,
    agents: { get: (u, id) => Promise.resolve(rec(id, u)) },
    agentFactory: () => () => {
      const a = new Driven();
      adapters.push(a);
      return Promise.resolve(a);
    },
    agentStatus: () => 'online',
    hasLiveCallToAgent: () => false,
    notify: (_u, frame) => frames.push(frame),
    timeouts: { firstEventMs: 500, idleMs: 500, connectMs: 500, totalMs: 5_000, ...opts.timeouts },
  });
  services.push(service);
  return { store, service, adapters, frames };
}
const send = (s: ThreadService, agent = A, user = 'u1', text = 'hi') =>
  s.send(user, agent, { clientId: randomUUID(), text });
async function until(check: () => boolean | Promise<boolean>, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('condition not reached');
}
type Approval = Extract<ThreadMessage, { kind: 'approval' }>;
const cards = async (st: SqliteThreadStore, agent = A, user = 'u1'): Promise<Approval[]> =>
  (await st.listMessages(user, agent, { limit: 100 })).messages.filter(
    (m): m is Approval => m.kind === 'approval',
  );
async function started(t: ReturnType<typeof setup>, agent = A, user = 'u1') {
  await send(t.service, agent, user);
  await until(() => t.adapters.length > 0 && t.adapters[0]!.turns.length > 0);
  const adapter = t.adapters[t.adapters.length - 1]!;
  adapter.push(approvalEvent('apr-1'));
  await until(async () => (await cards(t.store, agent, user)).length === 1);
  return { adapter, card: (await cards(t.store, agent, user))[0]! };
}
const userRow = async (t: ReturnType<typeof setup>) =>
  (await t.store.listMessages('u1', A, { limit: 100 })).messages.find(
    (m) => m.kind === 'user_text',
  );
const finished = (t: ReturnType<typeof setup>) =>
  until(async () => {
    const u = await userRow(t);
    return u?.kind === 'user_text' && !['sent', 'working', 'queued', 'sending'].includes(u.status);
  });

describe('approval races', () => {
  it('two simultaneous decisions: one wins, adapter sees exactly one decision', async () => {
    const t = setup();
    const { adapter, card } = await started(t);
    const results = await Promise.allSettled([
      t.service.decideApproval('u1', A, card.id, 'approve'),
      t.service.decideApproval('u1', A, card.id, 'deny'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    const reason = (bad[0] as PromiseRejectedResult).reason as ThreadServiceError;
    expect(reason.code).toBe('approval_conflict');
    const winner = (ok[0] as PromiseFulfilledResult<ThreadMessage>).value as Approval;
    expect(reason.current).toMatchObject({ status: winner.status });
    expect(adapter.decisions).toHaveLength(1);
    adapter.push('end');
  });

  it('a decision after the turn ended conflicts without touching the adapter', async () => {
    const t = setup();
    const { adapter, card } = await started(t);
    adapter.push('end');
    await until(async () => (await cards(t.store))[0]?.status === 'expired');
    adapter.decisions.length = 0;
    await expect(t.service.decideApproval('u1', A, card.id, 'approve')).rejects.toMatchObject({
      code: 'approval_conflict',
      current: { status: 'expired' },
    });
    expect(adapter.decisions).toEqual([]);
  });

  it.each([
    ['done', () => ev('done', { status: 'completed' })],
    ['failure', () => new Error('boom')],
    ['error event', () => ev('error', { code: 'agent_failed', message: 'x', recoverable: false })],
  ])('turn ending (%s) while pending expires the card exactly once', async (_n, make) => {
    const t = setup();
    const { adapter } = await started(t);
    adapter.push(make(), 'end');
    await until(async () => (await cards(t.store))[0]?.status === 'expired');
    expect(adapter.decisions).toEqual([['apr-1', 'deny']]);
  });

  it('stop while pending expires the card', async () => {
    const t = setup();
    const { adapter } = await started(t);
    const user = (await userRow(t))!;
    await t.service.stop('u1', user.id);
    await until(async () => (await cards(t.store))[0]?.status === 'expired');
    expect(adapter.decisions).toEqual([['apr-1', 'deny']]);
  });

  it('decision racing the turn ending: single adapter decision, final state consistent', async () => {
    const t = setup();
    const { adapter, card } = await started(t);
    adapter.decideImpl = () => new Promise((r) => setTimeout(r, 20));
    const decide = t.service.decideApproval('u1', A, card.id, 'approve');
    adapter.push('end'); // stream ends while the decision is in flight
    const result = await decide.catch((e: unknown) => e);
    await finished(t);
    const final = (await cards(t.store))[0]!;
    if (result instanceof Error) expect(final.status).not.toBe('pending');
    else expect(final.status).toBe('allowed');
    expect(adapter.decisions).toHaveLength(1);
  });

  it('decision racing the 10 minute expiry timer', async () => {
    vi.useFakeTimers();
    const t = setup({
      timeouts: { totalMs: APPROVAL_HOLD_MS * 3, idleMs: 100, firstEventMs: 100 },
    });
    await send(t.service);
    await vi.advanceTimersByTimeAsync(5);
    const adapter = t.adapters[0]!;
    adapter.push(approvalEvent('apr-1'));
    await vi.advanceTimersByTimeAsync(5);
    const card = (await cards(t.store))[0]!;
    adapter.decideImpl = () => new Promise((r) => setTimeout(r, 50));
    await vi.advanceTimersByTimeAsync(APPROVAL_HOLD_MS - 25);
    const settled = t.service.decideApproval('u1', A, card.id, 'approve').then(
      (v) => v,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(200);
    const result = await settled;
    const final = (await cards(t.store))[0]!;
    expect(final.status).not.toBe('pending');
    if (!(result instanceof Error)) expect(final.status).toBe('allowed');
    expect(adapter.decisions).toHaveLength(1);
    adapter.push('end');
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('approval isolation', () => {
  it('other user / other agent / non-approval id get approval_not_found', async () => {
    const t = setup();
    const { card } = await started(t);
    const user = (await userRow(t))!;
    for (const [u, a, id] of [
      ['u2', A, card.id],
      ['u1', B, card.id],
      ['u1', A, user.id],
      ['u1', A, `msg_${'z'.repeat(20)}`],
    ] as const)
      await expect(t.service.decideApproval(u, a, id, 'approve')).rejects.toMatchObject({
        code: 'approval_not_found',
      });
    expect((await cards(t.store))[0]?.status).toBe('pending');
    expect(t.adapters[0]!.decisions).toEqual([]);
  });
});

describe('adapter failure on decision', () => {
  it('a throwing adapter leaves the card pending, retry works, nothing unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const t = setup();
      const { adapter, card } = await started(t);
      let fail = true;
      adapter.decideImpl = () => (fail ? Promise.reject(new Error('down')) : Promise.resolve());
      await expect(t.service.decideApproval('u1', A, card.id, 'approve')).rejects.toThrow('down');
      expect((await cards(t.store))[0]?.status).toBe('pending');
      fail = false;
      expect(await t.service.decideApproval('u1', A, card.id, 'approve')).toMatchObject({
        status: 'allowed',
      });
      adapter.push('end');
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a hanging adapter decision does not wedge the turn or the run slot', async () => {
    vi.useFakeTimers();
    const t = setup({
      timeouts: { totalMs: APPROVAL_HOLD_MS * 3, idleMs: 100, firstEventMs: 100 },
    });
    await send(t.service);
    await vi.advanceTimersByTimeAsync(5);
    const adapter = t.adapters[0]!;
    adapter.push(approvalEvent('apr-1'));
    await vi.advanceTimersByTimeAsync(5);
    const card = (await cards(t.store))[0]!;
    adapter.decideImpl = () => new Promise<never>(() => undefined);
    void t.service.decideApproval('u1', A, card.id, 'approve').catch(() => undefined);
    adapter.push(ev('done', { status: 'completed' }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await userRow(t)).toMatchObject({ status: 'answered' });
    expect((await cards(t.store))[0]?.status).toBe('expired');
    await send(t.service);
    await vi.advanceTimersByTimeAsync(5);
    expect(t.adapters).toHaveLength(2);
  });
});

describe('approval timers', () => {
  it('the expiry timer is cleared when the turn ends', async () => {
    vi.useFakeTimers();
    const t = setup({
      timeouts: { totalMs: APPROVAL_HOLD_MS * 3, idleMs: 100, firstEventMs: 100 },
    });
    await send(t.service);
    await vi.advanceTimersByTimeAsync(5);
    t.adapters[0]!.push(approvalEvent('apr-1'));
    await vi.advanceTimersByTimeAsync(5);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    t.adapters[0]!.push('end');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the idle timeout does not end a turn while pending; the total limit still does', async () => {
    vi.useFakeTimers();
    const t = setup({ timeouts: { totalMs: 60_000, idleMs: 1_000, firstEventMs: 1_000 } });
    await send(t.service);
    await vi.advanceTimersByTimeAsync(5);
    t.adapters[0]!.push(approvalEvent('apr-1'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await cards(t.store))[0]?.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await userRow(t)).toMatchObject({ status: 'failed' });
    expect((await cards(t.store))[0]?.status).toBe('expired');
  });

  it('the approval timer is unref-ed so it cannot hold the process open', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const t = setup();
    await started(t);
    const hold = spy.mock.calls.findIndex(([, ms]) => ms === APPROVAL_HOLD_MS);
    expect(hold).toBeGreaterThanOrEqual(0);
    const handle = spy.mock.results[hold]!.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    t.adapters[0]!.push('end');
  });
});

describe('persistence', () => {
  it('restart expires pending approvals; title/description never plaintext in db or WAL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'appr-'));
    dirs.push(dir);
    const path = join(dir, 't.db');
    const t = setup({ path });
    const { card } = await started(t);
    expect(card).toMatchObject({ status: 'pending', description: 'secret-desc' });
    for (const file of [path, `${path}-wal`]) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(file);
      } catch {
        continue;
      }
      expect(bytes.includes(Buffer.from('secret-desc'))).toBe(false);
      expect(bytes.includes(Buffer.from('Run the report'))).toBe(false);
    }
    // "Restart": a fresh service over the same store runs start().
    const restarted = new ThreadService({
      store: t.store,
      agents: { get: (u, id) => Promise.resolve(rec(id, u)) },
      agentFactory: () => () => Promise.reject(new Error('unused')),
      agentStatus: () => 'offline',
      hasLiveCallToAgent: () => false,
      notify: () => undefined,
    });
    services.push(restarted);
    await restarted.start();
    expect((await cards(t.store))[0]?.status).toBe('expired');
    const page = await t.store.listMessages('u1', A, { limit: 10 });
    expect(page.messages.some((m) => m.kind === 'approval')).toBe(true);
  });
});

describe('clear chat / delete while pending', () => {
  it.each(['clear', 'deleteAllForUser', 'deleteAgent'] as const)(
    '%s while pending: no crash, no resurrected card, timers gone',
    async (how) => {
      vi.useFakeTimers();
      const t = setup({
        timeouts: { totalMs: APPROVAL_HOLD_MS * 3, idleMs: 100, firstEventMs: 100 },
      });
      await send(t.service);
      await vi.advanceTimersByTimeAsync(5);
      const adapter = t.adapters[0]!;
      adapter.push(approvalEvent('apr-1'));
      await vi.advanceTimersByTimeAsync(5);
      if (how === 'clear') await t.service.clear('u1', A);
      else if (how === 'deleteAllForUser') await t.service.deleteAllForUser('u1');
      else await t.service.deleteAgent('u1', A);
      adapter.push(approvalEvent('apr-late'), ev('text.delta', { message_id: 'm', delta: 'x' }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await cards(t.store)).toEqual([]);
      expect((await t.store.listMessages('u1', A, { limit: 10 })).messages).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('an approval event racing clear leaves no pending card in the cleared chat', async () => {
    const t = setup();
    await send(t.service);
    await until(() => t.adapters[0]?.turns.length === 1);
    t.adapters[0]!.push(approvalEvent('apr-race'));
    await t.service.clear('u1', A);
    await new Promise((r) => setTimeout(r, 60));
    expect((await cards(t.store)).filter((c) => c.status === 'pending')).toEqual([]);
  });

  it('an approval event racing stop leaves no pending card', async () => {
    const t = setup();
    await send(t.service);
    await until(() => t.adapters[0]?.turns.length === 1);
    const user = (await userRow(t))!;
    t.adapters[0]!.push(approvalEvent('apr-race'));
    await t.service.stop('u1', user.id);
    await new Promise((r) => setTimeout(r, 60));
    expect((await cards(t.store)).filter((c) => c.status === 'pending')).toEqual([]);
  });
});

describe('second approval while pending', () => {
  it('is denied at once and shows no second card', async () => {
    const t = setup();
    const { adapter } = await started(t);
    adapter.push(approvalEvent('apr-2'));
    await until(() => adapter.decisions.length === 1);
    expect(adapter.decisions).toEqual([['apr-2', 'deny']]);
    expect(await cards(t.store)).toHaveLength(1);
    adapter.push('end');
  });
});

describe('approval append racing stop or clear', () => {
  const slowAppend = (t: ReturnType<typeof setup>) => {
    const real = t.store.appendMessage.bind(t.store);
    const gate: { release: () => void } = { release: () => undefined };
    const entered = new Promise<void>((enter) => {
      vi.spyOn(t.store, 'appendMessage').mockImplementation(async (...args) => {
        if (args[2].kind !== 'approval') return real(...args);
        enter();
        await new Promise<void>((resolve) => (gate.release = resolve));
        return real(...args);
      });
    });
    return { gate, entered };
  };
  it.each(['stop', 'clear'] as const)(
    '%s while the card is being stored leaves no pending card',
    async (how) => {
      const t = setup();
      const { gate, entered } = slowAppend(t);
      await send(t.service);
      await until(() => t.adapters[0]?.turns.length === 1);
      const user = (await userRow(t))!;
      t.adapters[0]!.push(approvalEvent('apr-slow'));
      await entered;
      if (how === 'stop') await t.service.stop('u1', user.id);
      else await t.service.clear('u1', A);
      gate.release();
      await new Promise((r) => setTimeout(r, 80));
      expect((await cards(t.store)).filter((c) => c.status === 'pending')).toEqual([]);
    },
  );
});
