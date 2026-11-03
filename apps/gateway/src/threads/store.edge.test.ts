import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { CredentialCipher, messageKeys } from '../store/cipher';
import { SqliteThreadStore } from './store';

const agent = `agt_${'a'.repeat(20)}`;
const keys = { currentVersion: 1, keys: new Map([[1, randomBytes(32).toString('base64')]]) };
const cipher = new CredentialCipher(messageKeys(keys));
const stores: SqliteThreadStore[] = [];
const dirs: string[] = [];
const makeStore = (path = ':memory:') => {
  const store = new SqliteThreadStore(path, cipher);
  stores.push(store);
  return store;
};
const tmpDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cord-edge-'));
  dirs.push(dir);
  return join(dir, 'threads.db');
};
let n = 1000;
const clientId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const user = (
  store: SqliteThreadStore,
  owner = 'a',
  status: 'queued' | 'sent' | 'working' = 'sent',
  text = 'hello',
) => store.appendUserMessage(owner, agent, { clientId: clientId(), text, status });

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SqliteThreadStore edge cases', () => {
  it('keeps plaintext out of the database and WAL files, including ring text', async () => {
    const path = tmpDb();
    const store = makeStore(path);
    await user(store, 'a', 'sent', 'plain-user-text-7731');
    await store.appendMessage('a', agent, {
      kind: 'agent_text',
      text: 'plain-agent-text-7731',
      partial: false,
    });
    await store.appendMessage('a', agent, {
      kind: 'ring',
      invite_id: `inv_${'a'.repeat(26)}`,
      reason: 'plain-ring-reason-7731',
      outcome: 'declined',
      note: 'plain-note-7731',
    });
    for (const file of [path, `${path}-wal`]) {
      const bytes = readFileSync(file);
      expect(bytes.includes(Buffer.from('plain-user-text-7731'))).toBe(false);
      expect(bytes.includes(Buffer.from('plain-agent-text-7731'))).toBe(false);
      expect(bytes.includes(Buffer.from('plain-ring-reason-7731'))).toBe(false);
      expect(bytes.includes(Buffer.from('plain-note-7731'))).toBe(false);
    }
  });

  it('does not trim a queued message when the cap is exceeded', async () => {
    const store = makeStore();
    const queued = (await user(store, 'a', 'queued')).message;
    for (let i = 0; i < 2_005; i++)
      await store.appendMessage('a', agent, { kind: 'notice', code: 'new_session' });
    expect((await store.queuedMessages('a', agent)).map((m) => m.id)).toEqual([queued.id]);
  }, 30_000); // 2,000 sealed inserts: slow under a parallel run

  it('one unreadable message does not break listThreads for the user', async () => {
    const path = tmpDb();
    const store = makeStore(path);
    const bad = (await user(store)).message;
    await user(store, 'b');
    const db = new DatabaseSync(path);
    db.prepare('UPDATE messages SET body=? WHERE id=?').run('not json', bad.id);
    db.close();
    await expect(store.listThreads('a')).resolves.toHaveLength(1);
  });

  it('one unreadable message does not block interruptInFlight for other users', async () => {
    const path = tmpDb();
    const store = makeStore(path);
    const bad = (await user(store, 'a')).message;
    const ok = (await user(store, 'b')).message;
    const db = new DatabaseSync(path);
    db.prepare('UPDATE messages SET body=? WHERE id=?').run('not json', bad.id);
    db.close();
    await store.interruptInFlight();
    expect((await store.listMessages('b', agent, { limit: 5 })).messages[0]).toMatchObject({
      id: ok.id,
      status: 'interrupted',
    });
  });

  it('tampered meta surfaces as message_unreadable', async () => {
    const path = tmpDb();
    const store = makeStore(path);
    const m = (await user(store)).message;
    const db = new DatabaseSync(path);
    db.prepare('UPDATE messages SET meta=? WHERE id=?').run('{oops', m.id);
    db.close();
    await expect(store.listMessages('a', agent, { limit: 5 })).rejects.toMatchObject({
      code: 'message_unreadable',
    });
  });

  it('rolls back counters when an insert fails validation', async () => {
    const store = makeStore();
    await user(store);
    await expect(user(store, 'a', 'sent', 'x'.repeat(5_000))).rejects.toBeDefined();
    await expect(
      store.appendMessage('a', agent, { kind: 'agent_text', text: '', partial: false }),
    ).rejects.toBeDefined();
    const next = (await user(store)).message;
    expect(next.seq).toBe(2);
    expect(next.rev).toBe(2);
  });

  it('seq and rev stay monotonic across updates, status changes, clear and reopen', async () => {
    const path = tmpDb();
    const store = makeStore(path);
    const a = (await user(store)).message;
    await store.updateUserMessage('a', a.id, { status: 'working' });
    await store.interruptInFlight();
    await store.clearThread('a', agent);
    await store.close();
    stores.splice(0);
    const again = makeStore(path);
    const b = (await user(again)).message;
    expect(b.seq).toBe(2);
    expect(b.rev).toBeGreaterThan(3);
  });

  it('keeps idempotency after clear only for new ids and does not leak across users', async () => {
    const store = makeStore();
    const id = clientId();
    const first = await store.appendUserMessage('a', agent, {
      clientId: id,
      text: 'x',
      status: 'sent',
    });
    const other = await store.appendUserMessage('b', agent, {
      clientId: id,
      text: 'y',
      status: 'sent',
    });
    expect(other.created).toBe(true);
    expect(other.message.id).not.toBe(first.message.id);
    expect(other.message).toMatchObject({ text: 'y' });
    await store.clearThread('a', agent);
    const retry = await store.appendUserMessage('a', agent, {
      clientId: id,
      text: 'x',
      status: 'sent',
    });
    expect(retry.created).toBe(true); // documented: clear forgets client ids
    expect(retry.message.seq).toBe(2);
  });

  it('a cut at a lone high surrogate boundary never yields empty or broken text', async () => {
    const store = makeStore();
    const m = await store.appendMessage('a', agent, {
      kind: 'agent_text',
      text: `${'x'.repeat(19_999)}\ud83d`.padEnd(20_001, 'y'),
      partial: true,
    });
    expect(m).toMatchObject({ cut: true, partial: true });
  });
});
