import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { CredentialCipher, messageKeys } from '../store/cipher';
import { SqliteThreadStore, ThreadStoreError } from './store';

const agent = `agt_${'a'.repeat(20)}`;
const otherAgent = `agt_${'b'.repeat(20)}`;
const keys = { currentVersion: 1, keys: new Map([[1, randomBytes(32).toString('base64')]]) };
const cipher = new CredentialCipher(messageKeys(keys));
const stores: SqliteThreadStore[] = [];
const makeStore = (path = ':memory:', now?: () => Date) => {
  const store = new SqliteThreadStore(path, cipher, now);
  stores.push(store);
  return store;
};
let n = 0;
const clientId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const user = (
  store: SqliteThreadStore,
  owner = 'a',
  status: 'queued' | 'sent' | 'working' = 'sent',
  text = 'hello',
) => store.appendUserMessage(owner, agent, { clientId: clientId(), text, status });
const agentText = (store: SqliteThreadStore, owner = 'a', text = 'reply') =>
  store.appendMessage(owner, agent, { kind: 'agent_text', text, partial: false });

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('SqliteThreadStore', () => {
  it('paginates only owner replies, oldest first', async () => {
    let minute = 0;
    const store = makeStore(':memory:', () => new Date(Date.UTC(2026, 9, 20, 0, minute++)));
    const messages = [];
    for (let i = 0; i < 25; i++) {
      messages.push((await user(store, 'a', 'sent', `owner ${i}`)).message);
      if (i === 12) await agentText(store, 'a', 'agent reply');
    }
    expect(
      (await store.ownerReplies('a', agent, undefined, 10)).map((message) => message.text),
    ).toEqual(Array.from({ length: 10 }, (_, i) => `owner ${i + 15}`));
    const since = messages[4]!.created_at;
    expect(
      (await store.ownerReplies('a', agent, since, 20)).map((message) => message.text),
    ).toEqual(Array.from({ length: 20 }, (_, i) => `owner ${i + 5}`));
    expect(await store.ownerReplyCount('a', agent, since)).toBe(20);
  });
  it('seals approval details and updates or expires pending approvals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cord-approval-'));
    const path = join(dir, 'threads.db');
    try {
      const store = makeStore(path);
      const first = await store.appendMessage('a', agent, {
        kind: 'approval',
        approval_id: 'apr-1',
        title: 'Delete secret file',
        description: 'private explanation',
        status: 'pending',
        expires_at: '2026-10-13T10:10:00.000Z',
      });
      expect(first).toMatchObject({
        kind: 'approval',
        title: 'Delete secret file',
        status: 'pending',
      });
      expect(await store.updateApproval('a', agent, first.id, 'allowed')).toMatchObject({
        status: 'allowed',
        rev: first.rev + 1,
      });
      expect(await store.updateApproval('a', agent, first.id, 'denied')).toBeUndefined();
      const second = await store.appendMessage('a', agent, {
        kind: 'approval',
        approval_id: 'apr-2',
        title: 'Another action',
        status: 'pending',
        expires_at: '2026-10-13T10:10:00.000Z',
      });
      expect(await store.expirePendingApprovals()).toBe(1);
      expect(await store.findMessageById('a', agent, second.id)).toMatchObject({
        status: 'expired',
      });
      expect(await store.findMessageById('a', agent, first.id)).toMatchObject({
        status: 'allowed',
      });
      await store.close();
      stores.splice(stores.indexOf(store), 1);
      const bytes = readFileSync(path).toString('utf8');
      expect(bytes).not.toContain('Delete secret file');
      expect(bytes).not.toContain('private explanation');
      expect(bytes).not.toContain('Another action');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('stores a connector result once by client id', async () => {
    const store = makeStore();
    const input = {
      kind: 'agent_text' as const,
      text: 'full result',
      partial: false,
      clientId: 'retry-key',
    };
    const first = await store.appendMessage('a', agent, input);
    const second = await store.appendMessage('a', agent, { ...input, text: 'duplicate' });
    expect(first.created).toBe(true);
    expect(second).toEqual({ message: first.message, created: false });
  });
  it('finds distinct queued agents across owners', async () => {
    const store = makeStore();
    await user(store, 'a', 'queued');
    await user(store, 'a', 'queued');
    await user(store, 'b', 'queued');
    await user(store, 'c', 'sent');
    expect(await store.queuedAgents()).toEqual([
      { userId: 'a', agentId: agent },
      { userId: 'b', agentId: agent },
    ]);
  });
  it('keeps client idempotency, sequences, and revision catch-up', async () => {
    const store = makeStore();
    const id = clientId();
    const first = await store.appendUserMessage('a', agent, {
      clientId: id,
      text: 'first',
      status: 'sent',
    });
    const retry = await store.appendUserMessage('a', agent, {
      clientId: id,
      text: 'different',
      status: 'queued',
    });
    expect(retry).toEqual({ message: first.message, created: false });
    const second = await agentText(store);
    expect(second.seq).toBeGreaterThan(first.message.seq);
    const changed = await store.updateUserMessage('a', first.message.id, {
      status: 'answered',
      turnId: 'turn-1',
    });
    expect(changed?.seq).toBe(first.message.seq);
    expect(changed?.rev).toBeGreaterThan(second.rev);
    expect(
      (await store.listMessages('a', agent, { afterRev: second.rev, limit: 10 })).messages,
    ).toEqual([changed]);
    expect((await store.findUserMessageByTurn('a', 'turn-1'))?.id).toBe(first.message.id);
  });

  it('pages newest first and reports more', async () => {
    const store = makeStore();
    for (let i = 0; i < 4; i++) await user(store);
    const first = await store.listMessages('a', agent, { limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.messages.map((m) => m.seq)).toEqual([4, 3]);
    const next = await store.listMessages('a', agent, { beforeSeq: 3, limit: 2 });
    expect(next.messages.map((m) => m.seq)).toEqual([2, 1]);
    expect(next.hasMore).toBe(false);
  });

  it('isolates every owner scoped operation', async () => {
    const store = makeStore();
    const a = (await user(store)).message;
    await store.updateUserMessage('a', a.id, { turnId: 'secret-turn' });
    await agentText(store);
    const b = (await user(store, 'b')).message;
    expect(await store.updateUserMessage('b', a.id, { status: 'failed' })).toBeUndefined();
    expect(await store.findUserMessageByTurn('b', 'secret-turn')).toBeUndefined();
    expect(await store.listMessages('b', agent, { limit: 10 })).toEqual({
      messages: [b],
      hasMore: false,
    });
    expect((await store.listThreads('b')).length).toBe(1);
    expect(await store.queuedMessages('b', agent)).toEqual([]);
    await store.markRead('b', agent, 999);
    expect((await store.listThreads('a'))[0]?.read_seq).toBe(0);
    expect(await store.clearThread('b', agent)).toEqual({ messages: 1, fileIds: [] });
    expect((await store.listMessages('a', agent, { limit: 10 })).messages).toHaveLength(2);
    await user(store, 'b');
    expect(await store.deleteThread('b', agent)).toEqual({ messages: 1, fileIds: [] });
    expect((await store.listMessages('a', agent, { limit: 10 })).messages).toHaveLength(2);
    await user(store, 'b');
    expect(await store.clearThread('b', otherAgent)).toEqual({ messages: 0, fileIds: [] });
    expect(await store.deleteThread('b', otherAgent)).toEqual({ messages: 0, fileIds: [] });
    expect(await store.deleteAllForUser('b')).toEqual({ messages: 1, fileIds: [] });
    expect((await store.listMessages('a', agent, { limit: 10 })).messages).toHaveLength(2);
  });

  it('seals text on disk, uses WAL, and reopens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cord-threads-'));
    const path = join(dir, 'threads.db');
    try {
      const store = makeStore(path);
      const distinctive = 'secret-plain-text-449911';
      await user(store, 'a', 'sent', distinctive);
      await store.close();
      stores.splice(stores.indexOf(store), 1);
      expect(readFileSync(path).includes(Buffer.from(distinctive))).toBe(false);
      const reopened = makeStore(path);
      expect((await reopened.listMessages('a', agent, { limit: 10 })).messages[0]).toMatchObject({
        text: distinctive,
      });
      const db = new DatabaseSync(path);
      expect(
        (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
      ).toBe('wal');
      db.close();
    } finally {
      for (const store of stores.splice(0)) await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a tampered body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cord-tamper-'));
    const path = join(dir, 'threads.db');
    try {
      const store = makeStore(path);
      const saved = (await user(store)).message;
      const db = new DatabaseSync(path);
      db.prepare('UPDATE messages SET body=? WHERE id=?').run('{"bad":true}', saved.id);
      db.close();
      await expect(store.listMessages('a', agent, { limit: 10 })).rejects.toMatchObject({
        code: 'message_unreadable',
      });
    } finally {
      for (const store of stores.splice(0)) await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cuts agent text without splitting a surrogate pair', async () => {
    const message = await agentText(makeStore(), 'a', `${'x'.repeat(19_999)}😀more`);
    expect(message).toMatchObject({ kind: 'agent_text', cut: true });
    if (message.kind === 'agent_text') expect(message.text).toBe('x'.repeat(19_999));
  });

  it('drops the oldest over 2000 and keeps counters after clear', async () => {
    const store = makeStore();
    for (let i = 0; i < 2_001; i++) await user(store);
    const page = await store.listMessages('a', agent, { beforeSeq: 3, limit: 10 });
    expect(page.messages.map((m) => m.seq)).toEqual([2]);
    expect(await store.clearThread('a', agent)).toEqual({ messages: 2_000, fileIds: [] });
    const after = (await user(store)).message;
    expect(after.seq).toBe(2_002);
  }, 30_000); // 2,000 sealed inserts: slow under a parallel run

  it('limits queued messages and expires them using the injected clock', async () => {
    let time = new Date('2026-01-01T00:00:00.000Z');
    const store = makeStore(':memory:', () => time);
    for (let i = 0; i < 5; i++) await user(store, 'a', 'queued');
    await expect(user(store, 'a', 'queued')).rejects.toEqual(new ThreadStoreError('queue_full'));
    time = new Date('2026-01-02T00:00:00.001Z');
    const expired = await store.expireQueued();
    expect(expired).toHaveLength(5);
    expect(expired.every((m) => m.kind === 'user_text' && m.status === 'expired')).toBe(true);
    expect(await store.queuedMessages('a', agent)).toEqual([]);
  });

  it('interrupts only sent and working', async () => {
    const store = makeStore();
    const sent = (await user(store, 'a', 'sent')).message;
    const working = (await user(store, 'b', 'working')).message;
    const queued = (await user(store, 'c', 'queued')).message;
    expect(await store.interruptInFlight()).toBe(2);
    expect(await store.interruptInFlight()).toBe(0);
    expect((await store.listMessages('a', agent, { limit: 1 })).messages[0]).toMatchObject({
      id: sent.id,
      status: 'interrupted',
    });
    expect((await store.listMessages('b', agent, { limit: 1 })).messages[0]).toMatchObject({
      id: working.id,
      status: 'interrupted',
    });
    expect((await store.listMessages('c', agent, { limit: 1 })).messages[0]).toMatchObject({
      id: queued.id,
      status: 'queued',
    });
  });

  it('caps read markers and excludes own messages from unread', async () => {
    const store = makeStore();
    await user(store);
    await agentText(store);
    expect((await store.listThreads('a'))[0]?.unread).toBe(1);
    await store.markRead('a', agent, 999);
    await store.markRead('a', agent, 0);
    expect((await store.listThreads('a'))[0]).toMatchObject({ read_seq: 2, unread: 0 });
  });
});
