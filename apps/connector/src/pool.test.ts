import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalAgentAdapter, LocalAgentEvent } from './events';
import { AgentPool, IDLE_CLOSE_MS } from './pool';

class Adapter implements LocalAgentAdapter {
  closed = false;
  ref: string | undefined;
  constructor(ref?: string) {
    this.ref = ref;
  }
  // eslint-disable-next-line require-yield, @typescript-eslint/require-await -- turns are controlled by pool tests
  async *sendTurn(): AsyncIterable<LocalAgentEvent> {
    return;
  }
  sessionRef(): string | undefined {
    return this.ref;
  }
  close(): void {
    this.closed = true;
  }
}

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(log?: (line: string) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'cord-pool-'));
  dirs.push(dir);
  const calls: { agent: string; resume?: string; adapter: Adapter }[] = [];
  const pool = new AgentPool({
    dir,
    idleCloseMs: 100,
    log,
    createAdapter: (agent, resume) => {
      const adapter = new Adapter(resume);
      calls.push({ agent, resume, adapter });
      return adapter;
    },
  });
  return { pool, calls, dir };
}

const ravi = 'a'.repeat(32);
const meera = 'b'.repeat(32);

/** Runs one turn for the key so the adapter's current ref is saved. */
async function saveTurn(pool: AgentPool, adapter: Adapter, ref: string, scope?: string) {
  adapter.ref = ref;
  await pool.runExclusive('hermes', () => Promise.resolve(), scope);
}

describe('who may resume which session', () => {
  it("never resumes a session saved under another person's key", async () => {
    const { calls, dir } = await setup();
    await writeFile(
      join(dir, 'sessions.json'),
      JSON.stringify({ hermes: 'sess_owner', [`hermes#${ravi}`]: 'sess_ravi' }),
    );
    const fresh = new AgentPool({
      dir,
      createAdapter: (agent, resume) => {
        const adapter = new Adapter(resume);
        calls.push({ agent, resume, adapter });
        return adapter;
      },
    });
    const last = () => calls.at(-1)?.resume;
    fresh.acquire('hermes', 'sess_ravi', false, meera);
    expect(last()).toBeUndefined();
    fresh.acquire('hermes', 'sess_owner', false, `${'c'.repeat(32)}`);
    expect(last()).toBeUndefined();
    fresh.acquire('hermes', 'sess_ravi');
    expect(last()).toBe('sess_owner');
    fresh.acquire('hermes', 'sess_ravi', false, ravi);
    expect(last()).toBe('sess_ravi');
    fresh.closeAll();
  });

  it("a member's older session (no longer current) stays theirs and nobody else's", async () => {
    const { pool, calls } = await setup();
    const first = pool.acquire('hermes', undefined, false, ravi) as Adapter;
    await saveTurn(pool, first, 'sess_ravi_old', ravi);
    pool.release('hermes', ravi);
    // Ravi starts a new conversation: the current ref moves on.
    const second = pool.acquire('hermes', undefined, true, ravi) as Adapter;
    await saveTurn(pool, second, 'sess_ravi_new', ravi);
    pool.release('hermes', ravi);
    expect(pool.sessionRef('hermes', ravi)).toBe('sess_ravi_new');
    // P2: Meera naming Ravi's old session starts fresh.
    pool.acquire('hermes', 'sess_ravi_old', false, meera);
    expect(calls.at(-1)?.resume).toBeUndefined();
    pool.release('hermes', meera);
    // The owner naming it starts from the owner's own state, not Ravi's.
    pool.acquire('hermes', 'sess_ravi_old');
    expect(calls.at(-1)?.resume).toBeUndefined();
    pool.release('hermes');
    // Ravi can go back to it.
    pool.acquire('hermes', 'sess_ravi_old', false, ravi);
    expect(calls.at(-1)?.resume).toBe('sess_ravi_old');
    pool.closeAll();
  });

  it("a member never resumes a session the pool has not saved for them (owner's terminal)", async () => {
    const log = vi.fn();
    const { pool, calls } = await setup(log);
    // P3: a session id never saved by the pool (the owner's terminal, or an earlier owner
    // Twring session) starts fresh for a member.
    pool.acquire('hermes', 'sess_owner_terminal', false, meera);
    expect(calls.at(-1)?.resume).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).not.toContain('sess_owner_terminal');
    pool.closeAll();
  });

  it('a member can answer a ring for the session still running its first turn', async () => {
    const { pool, calls } = await setup();
    const live = pool.acquire('hermes', undefined, false, meera) as Adapter;
    let finish!: () => void;
    const running = pool.runExclusive(
      'hermes',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      meera,
    );
    await Promise.resolve();
    live.ref = 'sess_meera_live';
    pool.release('hermes', meera);
    // Nothing saved yet, but the live adapter owns this ref.
    expect(pool.acquire('hermes', 'sess_meera_live', false, meera)).toBe(live);
    expect(calls).toHaveLength(1);
    finish();
    await running;
    pool.closeAll();
  });

  it('the owner still resumes an unknown session (a terminal session rang them)', async () => {
    const { pool, calls } = await setup();
    const member = pool.acquire('hermes', undefined, false, ravi) as Adapter;
    await saveTurn(pool, member, 'sess_ravi', ravi);
    pool.release('hermes', ravi);
    pool.acquire('hermes', 'sess_terminal');
    expect(calls.at(-1)?.resume).toBe('sess_terminal');
    pool.closeAll();
  });

  it('keeps the last 20 saved sessions per key', async () => {
    const { pool, calls } = await setup();
    const adapter = pool.acquire('hermes', undefined, false, ravi) as Adapter;
    for (let i = 1; i <= 21; i += 1) await saveTurn(pool, adapter, `sess_${i}`, ravi);
    pool.release('hermes', ravi);
    pool.acquire('hermes', 'sess_1', false, ravi);
    expect(calls.at(-1)?.resume).toBeUndefined();
    pool.release('hermes', ravi);
    pool.acquire('hermes', 'sess_2', false, ravi);
    expect(calls.at(-1)?.resume).toBe('sess_2');
    pool.closeAll();
  });

  it('loads an old-format sessions.json and resumes the owner from it', async () => {
    const { calls, dir } = await setup();
    await writeFile(join(dir, 'sessions.json'), JSON.stringify({ hermes: 'sess_owner' }));
    const pool = new AgentPool({
      dir,
      createAdapter: (agent, resume) => {
        const adapter = new Adapter(resume);
        calls.push({ agent, resume, adapter });
        return adapter;
      },
    });
    pool.acquire('hermes');
    expect(calls.at(-1)?.resume).toBe('sess_owner');
    pool.release('hermes');
    pool.acquire('hermes', 'sess_owner', false, meera);
    expect(calls.at(-1)?.resume).toBeUndefined();
    pool.closeAll();
  });

  it('remembers a saved history across a restart', async () => {
    const { pool, calls, dir } = await setup();
    const adapter = pool.acquire('hermes', undefined, false, ravi) as Adapter;
    await saveTurn(pool, adapter, 'sess_ravi_old', ravi);
    await saveTurn(pool, adapter, 'sess_ravi_new', ravi);
    pool.closeAll();
    const again = new AgentPool({
      dir,
      createAdapter: (agent, resume) => {
        const adapter = new Adapter(resume);
        calls.push({ agent, resume, adapter });
        return adapter;
      },
    });
    again.acquire('hermes', 'sess_ravi_old', false, ravi);
    expect(calls.at(-1)?.resume).toBe('sess_ravi_old');
    again.release('hermes', ravi);
    again.acquire('hermes', 'sess_ravi_old');
    expect(calls.at(-1)?.resume).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'))).toEqual({
      [`hermes#${ravi}`]: 'sess_ravi_new',
    });
    again.closeAll();
  });
});

describe('agent pool', () => {
  it('keeps one session per person scope; the unscoped one keeps its old key', async () => {
    const { pool, calls, dir } = await setup();
    const scope = 'd'.repeat(32);
    const owner = pool.acquire('hermes') as Adapter;
    const member = pool.acquire('hermes', undefined, false, scope) as Adapter;
    expect(member).not.toBe(owner);
    expect(calls).toHaveLength(2);
    owner.ref = 'session_owner';
    member.ref = 'session_member';
    await pool.runExclusive('hermes', () => Promise.resolve());
    await pool.runExclusive('hermes', () => Promise.resolve(), scope);
    expect(pool.sessionRef('hermes')).toBe('session_owner');
    expect(pool.sessionRef('hermes', scope)).toBe('session_member');
    expect(JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'))).toEqual({
      hermes: 'session_owner',
      [`hermes#${scope}`]: 'session_member',
    });
    // A fresh session for the member leaves the owner's alone.
    pool.release('hermes', scope);
    pool.acquire('hermes', undefined, true, scope);
    expect(JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'))).toEqual({
      hermes: 'session_owner',
    });
    pool.release('hermes');
    pool.closeAll();
    // After a restart each resumes its own.
    const again = new AgentPool({
      dir,
      createAdapter: (agent, resume) => {
        const adapter = new Adapter(resume);
        calls.push({ agent, resume, adapter });
        return adapter;
      },
    });
    again.acquire('hermes');
    expect(calls.at(-1)?.resume).toBe('session_owner');
  });

  it('forgets an idle saved session and stays fresh after restart', async () => {
    const { pool, calls, dir } = await setup();
    const old = pool.acquire('hermes') as Adapter;
    old.ref = 'session_old';
    await pool.runExclusive('hermes', () => Promise.resolve());
    pool.release('hermes');
    const fresh = pool.acquire('hermes', 'ring_old', true) as Adapter;
    expect(old.closed).toBe(true);
    expect(fresh).not.toBe(old);
    expect(calls[1]?.resume).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'))).toEqual({});
    pool.release('hermes');
    pool.closeAll();
    const restarted = new AgentPool({
      dir,
      createAdapter: (_agent, ref) => {
        expect(ref).toBeUndefined();
        return new Adapter(ref);
      },
    });
    restarted.acquire('hermes');
    restarted.closeAll();
  });

  it('keeps a busy adapter until idle without restoring its retired ref', async () => {
    const { pool, calls, dir } = await setup();
    const old = pool.acquire('hermes') as Adapter;
    old.ref = 'session_old';
    await pool.runExclusive('hermes', () => Promise.resolve());
    let finish!: () => void;
    const running = pool.runExclusive(
      'hermes',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    pool.release('hermes');
    expect(pool.acquire('hermes', undefined, true)).toBe(old);
    expect(old.closed).toBe(false);
    pool.release('hermes');
    finish();
    await running;
    expect(JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'))).toEqual({});
    expect(pool.acquire('hermes', 'old_ring_ref')).not.toBe(old);
    expect(old.closed).toBe(true);
    expect(calls[1]?.resume).toBeUndefined();
    pool.closeAll();
  });
  it('reuses one adapter and session over two calls', async () => {
    const { pool, calls } = await setup();
    const first = pool.acquire('hermes')!;
    (first as Adapter).ref = 'session_1';
    await pool.runExclusive('hermes', () => Promise.resolve());
    pool.release('hermes');
    expect(pool.acquire('hermes')).toBe(first);
    expect(calls).toHaveLength(1);
    expect(pool.sessionRef('hermes')).toBe('session_1');
    pool.release('hermes');
    pool.closeAll();
  });

  it('closes after the idle deadline, cancels that timer on acquire, and waits for work', async () => {
    vi.useFakeTimers();
    const { pool, calls } = await setup();
    const first = pool.acquire('hermes')!;
    pool.release('hermes');
    await vi.advanceTimersByTimeAsync(90);
    expect(pool.acquire('hermes')).toBe(first);
    await vi.advanceTimersByTimeAsync(20);
    expect((first as Adapter).closed).toBe(false);
    let finish!: () => void;
    const pending = pool.runExclusive(
      'hermes',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    pool.release('hermes');
    await vi.advanceTimersByTimeAsync(100);
    expect((first as Adapter).closed).toBe(false);
    finish();
    await pending;
    expect((first as Adapter).closed).toBe(true);
    expect(pool.acquire('hermes')).not.toBe(first);
    expect(calls).toHaveLength(2);
    pool.closeAll();
    expect(IDLE_CLOSE_MS).toBe(30 * 60_000);
  });

  it('saves and resumes a valid session after idle close; ignores a damaged file', async () => {
    vi.useFakeTimers();
    const { pool, calls, dir } = await setup();
    const first = pool.acquire('hermes') as Adapter;
    first.ref = 'session_2';
    await pool.runExclusive('hermes', () => Promise.resolve());
    pool.release('hermes');
    await vi.advanceTimersByTimeAsync(100);
    pool.acquire('hermes');
    expect(calls[1]?.resume).toBe('session_2');
    expect(JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'))).toEqual({
      hermes: 'session_2',
    });
    if (process.platform !== 'win32')
      expect((await stat(join(dir, 'sessions.json'))).mode & 0o777).toBe(0o600);
    pool.closeAll();
    const restarted = new AgentPool({
      dir,
      createAdapter: (_agent, resume) => {
        expect(resume).toBe('session_2');
        return new Adapter(resume);
      },
    });
    restarted.acquire('hermes');
    restarted.closeAll();
    await writeFile(join(dir, 'sessions.json'), 'bad json');
    const other = new AgentPool({
      dir,
      createAdapter: (_agent, resume) => {
        expect(resume).toBeUndefined();
        return new Adapter();
      },
    });
    other.acquire('hermes');
    other.closeAll();
  });

  it('replaces an idle live session for a different resume ref but keeps a busy one', async () => {
    const { pool, calls } = await setup();
    const first = pool.acquire('hermes', 'session_1') as Adapter;
    pool.release('hermes');
    const second = pool.acquire('hermes', 'session_2');
    expect(first.closed).toBe(true);
    expect(second).not.toBe(first);
    expect(calls[1]?.resume).toBe('session_2');
    let finish!: () => void;
    const pending = pool.runExclusive(
      'hermes',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    pool.release('hermes');
    expect(pool.acquire('hermes', 'session_3')).toBe(second);
    finish();
    await pending;
    pool.release('hermes');
    pool.closeAll();
  });

  it('serializes another call behind background work', async () => {
    const { pool } = await setup();
    pool.acquire('hermes');
    const order: string[] = [];
    let finish!: () => void;
    const background = pool.runExclusive(
      'hermes',
      () =>
        new Promise<void>((resolve) => {
          order.push('background');
          finish = resolve;
        }),
    );
    await Promise.resolve();
    pool.release('hermes');
    pool.acquire('hermes');
    const next = pool.runExclusive('hermes', () => {
      order.push('next');
      return Promise.resolve();
    });
    expect(order).toEqual(['background']);
    finish();
    await Promise.all([background, next]);
    expect(order).toEqual(['background', 'next']);
    pool.closeAll();
  });
});
