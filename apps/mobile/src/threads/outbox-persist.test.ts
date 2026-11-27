import type { ThreadMessage } from '@twring/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { DraftStore } from './drafts';
import { FILE_MISSING, Outbox, VOICE_MISSING, canRetry } from './outbox';
import { memoryStore, storageScope, type OutboxFiles } from './outbox-storage';

const agent = 'agt_abcdefghij0123456789';
const echo = (clientId: string): ThreadMessage => ({
  id: 'msg_aaaaaaaaaaaaaaaaaaaa',
  agent_id: agent,
  seq: 1,
  rev: 1,
  kind: 'user_text',
  text: 'hello',
  status: 'sent',
  client_id: clientId,
  created_at: '2026-10-13T00:00:00.000Z',
  updated_at: '2026-10-13T00:00:00.000Z',
});
const timers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
type Send = (
  agentId: string,
  request: { clientId: string; text: string },
  signal: AbortSignal,
) => Promise<ThreadMessage>;
const networkDown = () => Promise.reject(new ApiError('network'));
const never = () => new Promise<ThreadMessage>(() => undefined);

function memoryFiles(present: string[] = []): OutboxFiles & { present: Set<string> } {
  const files = {
    present: new Set(present),
    keep: (clientId: string, uri: string) => {
      const kept = `doc://outbox/${clientId}/${uri.split('/').at(-1)}`;
      files.present.add(kept);
      return Promise.resolve(kept);
    },
    exists: (uri: string) => files.present.has(uri),
    remove: (uri: string) => {
      files.present.delete(uri);
    },
  };
  return files;
}

describe('durable outbox', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves once after the debounce, coalescing changes', async () => {
    const store = memoryStore();
    const outbox = new Outbox(vi.fn<Send>(never), () => undefined, timers, undefined, { store });
    await outbox.hydrated;
    outbox.send(agent, 'one');
    outbox.send(agent, 'two');
    outbox.send(agent, 'three');
    await vi.advanceTimersByTimeAsync(299);
    expect(store.saves).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.saves).toBe(1);
    expect((store.value as { items: unknown[] }).items).toHaveLength(3);
  });

  it('resends a saved message after a restart with the same clientId', async () => {
    const store = memoryStore();
    const first = new Outbox(vi.fn<Send>(never), () => undefined, timers, undefined, { store });
    await first.hydrated;
    const clientId = first.send(agent, 'hello');
    await vi.advanceTimersByTimeAsync(300);

    const send = vi.fn<Send>((_agent, request) => Promise.resolve(echo(request.clientId)));
    const second = new Outbox(send, () => undefined, timers, undefined, { store });
    await second.hydrated;
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1].clientId).toBe(clientId);
    expect(second.list(agent)).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    // Reconcile removed it from storage too.
    expect(store.value).toBeUndefined();
  });

  it('brings a failed message back as sending and stores only an error code', async () => {
    const store = memoryStore();
    const first = new Outbox(
      vi.fn<Send>(() =>
        Promise.reject(new ApiError('http', 'agent_offline', undefined, undefined, 400)),
      ),
      () => undefined,
      timers,
      undefined,
      { store },
    );
    await first.hydrated;
    first.send(agent, 'hello');
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    const saved = (store.value as { items: Record<string, unknown>[] }).items[0];
    expect(saved.state).toBe('failed');
    expect(saved.errorCode).toBe('agent_offline');
    expect(saved).not.toHaveProperty('error');

    const second = new Outbox(vi.fn<Send>(never), () => undefined, timers, undefined, { store });
    await second.hydrated;
    expect(second.list(agent)[0].state).toBe('sending');
  });

  it('empties storage on clear, even with a write pending', async () => {
    const store = memoryStore();
    const outbox = new Outbox(vi.fn<Send>(never), () => undefined, timers, undefined, { store });
    await outbox.hydrated;
    outbox.send(agent, 'one');
    await vi.advanceTimersByTimeAsync(300);
    outbox.send(agent, 'two');
    await outbox.clear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.value).toBeUndefined();
  });

  it('keeps the saved queue when detached (switching servers)', async () => {
    const store = memoryStore();
    const outbox = new Outbox(vi.fn<Send>(never), () => undefined, timers, undefined, { store });
    await outbox.hydrated;
    outbox.send(agent, 'one');
    await outbox.detach();
    expect((store.value as { items: unknown[] }).items).toHaveLength(1);
    expect(outbox.list(agent)).toEqual([]);
  });

  it.each([
    ['not json', '{oops'],
    ['an unknown version', { version: 9, items: [] }],
    ['a wrong shape', { version: 1, items: [{ clientId: 3 }] }],
  ])('ignores and removes %s', async (_name, value) => {
    const store = memoryStore();
    store.value = value;
    const remove = vi.spyOn(store, 'remove');
    const outbox = new Outbox(vi.fn<Send>(never), () => undefined, timers, undefined, { store });
    await outbox.hydrated;
    expect(remove).toHaveBeenCalled();
    expect(outbox.list(agent)).toEqual([]);
  });

  it('survives a load that throws', async () => {
    const store = memoryStore();
    store.load = () => Promise.reject(new Error('unreadable'));
    const outbox = new Outbox(vi.fn<Send>(never), () => undefined, timers, undefined, { store });
    await expect(outbox.hydrated).resolves.toBeUndefined();
  });

  it('copies a voice note into the outbox folder and fails it if the copy is gone', async () => {
    const store = memoryStore();
    const files = memoryFiles(['cache://rec.m4a']);
    const first = new Outbox(vi.fn<Send>(never), () => undefined, timers, undefined, {
      store,
      files: () => Promise.resolve(files),
    });
    await first.hydrated;
    const clientId = first.sendVoice(agent, 'cache://rec.m4a', 4_000);
    await settle();
    const kept = `doc://outbox/${clientId}/rec.m4a`;
    expect(first.list(agent)[0].voice?.uri).toBe(kept);
    expect(files.present.has('cache://rec.m4a')).toBe(false);
    await vi.advanceTimersByTimeAsync(300);

    files.present.delete(kept);
    const send = vi.fn<Send>(never);
    const second = new Outbox(send, () => undefined, timers, undefined, {
      store,
      files: () => Promise.resolve(files),
    });
    await second.hydrated;
    await settle();
    expect(second.list(agent)).toMatchObject([
      { clientId, state: 'failed', errorCode: VOICE_MISSING },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a voice note's consent across a save and reload", async () => {
    const store = memoryStore();
    const files = memoryFiles(['cache://a.m4a', 'cache://b.m4a']);
    const first = new Outbox(vi.fn<Send>(never), () => undefined, timers, undefined, {
      store,
      files: () => Promise.resolve(files),
    });
    await first.hydrated;
    const yes = first.sendVoice(agent, 'cache://a.m4a', 4_000, undefined, { serverReadable: true });
    const no = first.sendVoice(agent, 'cache://b.m4a', 4_000);
    await settle();
    await vi.advanceTimersByTimeAsync(300);

    const send = vi.fn<Send>(never);
    const second = new Outbox(send, () => undefined, timers, undefined, {
      store,
      files: () => Promise.resolve(files),
    });
    await second.hydrated;
    await settle();
    const voiceOf = (id: string) => second.list(agent).find((i) => i.clientId === id)?.voice;
    expect(voiceOf(yes)?.serverReadable).toBe(true);
    expect(voiceOf(no)?.serverReadable).toBeUndefined();
  });

  it('discards a failed voice note for good, with its kept copy', async () => {
    const store = memoryStore();
    const files = memoryFiles(['cache://rec.m4a']);
    const first = new Outbox(
      vi.fn<Send>(() =>
        Promise.reject(new ApiError('http', 'private_thread', undefined, undefined, 409)),
      ),
      () => undefined,
      timers,
      undefined,
      { store, files: () => Promise.resolve(files) },
    );
    await first.hydrated;
    const clientId = first.sendVoice(agent, 'cache://rec.m4a', 4_000);
    await settle();
    expect(first.list(agent)[0].state).toBe('failed');
    first.discard(clientId);
    await settle();
    expect(first.list(agent)).toEqual([]);
    expect(files.present.size).toBe(0);
    await vi.advanceTimersByTimeAsync(300);

    const second = new Outbox(vi.fn<Send>(never), () => undefined, timers, undefined, {
      store,
      files: () => Promise.resolve(files),
    });
    await second.hydrated;
    expect(second.list(agent)).toEqual([]);
  });

  it('does not discard a message still sending', async () => {
    const outbox = new Outbox(vi.fn<Send>(never), () => undefined, timers);
    const clientId = outbox.send(agent, 'hello');
    await settle();
    outbox.discard(clientId);
    expect(outbox.list(agent)).toHaveLength(1);
  });

  it('deletes the kept copy once the server has the message', async () => {
    const store = memoryStore();
    const files = memoryFiles(['cache://rec.m4a']);
    const send = vi.fn<Send>((_agent, request) => Promise.resolve(echo(request.clientId)));
    const outbox = new Outbox(send, () => undefined, timers, undefined, {
      store,
      files: () => Promise.resolve(files),
    });
    await outbox.hydrated;
    outbox.sendVoice(agent, 'cache://rec.m4a', 4_000);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(files.present.size).toBe(0);
  });

  it('does not send twice when a save lands during an attempt', async () => {
    const store = memoryStore();
    let resolve: (message: ThreadMessage) => void = () => undefined;
    const send = vi.fn<Send>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const outbox = new Outbox(send, () => undefined, timers, undefined, { store });
    await outbox.hydrated;
    const clientId = outbox.send(agent, 'hello');
    await vi.advanceTimersByTimeAsync(300);
    outbox.send(agent, 'second');
    await vi.advanceTimersByTimeAsync(300);
    resolve(echo(clientId));
    await settle();
    expect(send.mock.calls.filter((call) => call[1].clientId === clientId)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300);
    expect((store.value as { items: { clientId: string }[] }).items.map((i) => i.clientId)).toEqual(
      [expect.not.stringMatching(clientId)],
    );
  });

  it('keeps the newest 50 messages', async () => {
    const store = memoryStore();
    const outbox = new Outbox(vi.fn<Send>(networkDown), () => undefined, timers, undefined, {
      store,
    });
    await outbox.hydrated;
    for (let i = 0; i < 60; i++) outbox.send(agent, `m${i}`);
    await outbox.flush();
    const items = (store.value as { items: { text: string }[] }).items;
    expect(items).toHaveLength(50);
    expect(items.at(-1)?.text).toBe('m59');
    await outbox.clear();
  });
});

describe('storage scope', () => {
  it('isolates accounts and servers', async () => {
    const a = storageScope({ kind: 'hosted' }, 'user-a');
    const b = storageScope({ kind: 'hosted' }, 'user-b');
    const self = storageScope({ kind: 'selfhost', serverId: 'srv/1', personId: 'p 1' }, 'user-a');
    expect(new Set([a, b, self]).size).toBe(3);
    expect(self).toBe('selfhost_srv_1_p_1');
    expect(storageScope({ kind: 'hosted' }, undefined)).toBeUndefined();

    // Two accounts' stores never see each other's queue.
    const stores = new Map([
      [a, memoryStore()],
      [b, memoryStore()],
    ]);
    vi.useFakeTimers();
    const first = new Outbox(vi.fn<Send>(never), () => undefined, timers, undefined, {
      store: stores.get(a)!,
    });
    await first.hydrated;
    first.send(agent, 'from a');
    await first.detach();
    const send = vi.fn<Send>(never);
    const second = new Outbox(send, () => undefined, timers, undefined, { store: stores.get(b)! });
    await second.hydrated;
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(second.list(agent)).toEqual([]);
    vi.useRealTimers();
  });
});

describe('drafts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('round-trips a draft and clears it on send', async () => {
    const store = memoryStore();
    const first = new DraftStore(store, timers);
    await first.hydrated;
    first.set(agent, 'half a thought');
    first.set(agent, 'half a thought, finished');
    await vi.advanceTimersByTimeAsync(300);
    expect(store.saves).toBe(1);

    const second = new DraftStore(store, timers);
    expect(await second.get(agent)).toBe('half a thought, finished');
    second.set(agent, '');
    await vi.advanceTimersByTimeAsync(300);
    expect(store.value).toBeUndefined();
  });

  it('caps a draft at the composer limit and ignores a corrupt file', async () => {
    const store = memoryStore();
    store.value = { version: 1, drafts: { [agent]: 7 } };
    const drafts = new DraftStore(store, timers);
    expect(await drafts.get(agent)).toBe('');
    drafts.set(agent, 'x'.repeat(10_000));
    expect((await drafts.get(agent)).length).toBe(4_000);
  });

  it('forgets every draft on clear', async () => {
    const store = memoryStore();
    const drafts = new DraftStore(store, timers);
    await drafts.hydrated;
    drafts.set(agent, 'secret');
    await drafts.clear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.value).toBeUndefined();
  });
});

describe('a stuck message after a restart', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const oldDoc = 'file:///var/mobile/Containers/Data/Application/OLD/Documents';
  const newDoc = 'file:///var/mobile/Containers/Data/Application/NEW/Documents';
  const savedItem = (extra: Record<string, unknown>) => ({
    clientId: 'c-1',
    agentId: agent,
    text: 'Voice note',
    state: 'failed',
    createdAt: '2026-11-26T18:52:00.000Z',
    voice: { uri: `${oldDoc}/outbox/c-1/rec.m4a`, durationMs: 7000 },
    ...extra,
  });
  const restart = async (item: Record<string, unknown>, present: string[]) => {
    const store = memoryStore();
    store.value = { version: 1, items: [item] };
    const files = memoryFiles(present);
    const locate = (uri: string) => {
      if (files.present.has(uri)) return uri;
      const moved = uri.replace(oldDoc, newDoc);
      return files.present.has(moved) ? moved : undefined;
    };
    const send = vi.fn<Send>((_agent, request) => Promise.resolve(echo(request.clientId)));
    const outbox = new Outbox(send, () => undefined, timers, undefined, {
      store,
      files: () => Promise.resolve({ ...files, locate }),
    });
    await outbox.hydrated;
    await settle();
    return { outbox, send, store, files };
  };

  it('finds a kept recording again after iOS moves the app folder, and sends it from there', async () => {
    const moved = `${newDoc}/outbox/c-1/rec.m4a`;
    const { send } = await restart(savedItem({ state: 'sending' }), [moved]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][1] as { voice?: { uri: string } }).voice?.uri).toBe(moved);
  });

  it('a recording found nowhere comes back failed as voice_missing', async () => {
    const { outbox, send } = await restart(savedItem({ state: 'sending' }), []);
    expect(outbox.list(agent)).toMatchObject([{ state: 'failed', errorCode: VOICE_MISSING }]);
    expect(send).not.toHaveBeenCalled();
  });

  for (const errorCode of ['private_thread', 'http']) {
    it(`keeps a saved ${errorCode} failure failed and does not send it`, async () => {
      const { outbox, send } = await restart(savedItem({ errorCode }), [
        `${oldDoc}/outbox/c-1/rec.m4a`,
      ]);
      expect(outbox.list(agent)).toMatchObject([{ state: 'failed', errorCode }]);
      expect(send).not.toHaveBeenCalled();
    });
  }

  for (const errorCode of ['file_missing', 'voice_missing']) {
    it(`keeps a saved ${errorCode} failure failed while its file is still gone`, async () => {
      const { outbox, send } = await restart(savedItem({ errorCode }), []);
      expect(outbox.list(agent)).toMatchObject([{ state: 'failed', errorCode: VOICE_MISSING }]);
      expect(send).not.toHaveBeenCalled();
    });
  }

  for (const errorCode of [
    'network',
    'agent_offline',
    'timeout',
    'rate_limited',
    'file_missing',
    'voice_missing',
  ]) {
    it(`resends a saved ${errorCode} failure`, async () => {
      const { send } = await restart(savedItem({ errorCode }), [`${oldDoc}/outbox/c-1/rec.m4a`]);
      expect(send).toHaveBeenCalledTimes(1);
    });
  }

  it('discarding a restored item deletes the copy at its moved path and saves at once', async () => {
    const moved = `${newDoc}/outbox/c-1/rec.m4a`;
    const { outbox, store, files } = await restart(savedItem({ errorCode: 'private_thread' }), [
      moved,
    ]);
    outbox.discard('c-1');
    await settle();
    expect(store.value).toBeUndefined();
    expect(files.present.has(moved)).toBe(false);
  });

  it('a recording that cannot be read fails as voice_missing, with no retries', async () => {
    const store = memoryStore();
    const files = memoryFiles(['cache://rec.m4a']);
    const send = vi.fn<Send>(() => Promise.reject(new ApiError('file_missing')));
    const outbox = new Outbox(send, () => undefined, timers, undefined, {
      store,
      files: () => Promise.resolve(files),
    });
    await outbox.hydrated;
    const clientId = outbox.sendVoice(agent, 'cache://rec.m4a', 7_000);
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledTimes(1);
    const [item] = outbox.list(agent);
    expect(item).toMatchObject({ clientId, state: 'failed', errorCode: VOICE_MISSING });
    expect(canRetry(item)).toBe(false);
    outbox.retry(clientId);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(outbox.list(agent)[0].state).toBe('failed');
  });

  it('a file that cannot be read fails as file_missing', async () => {
    const upload = vi.fn(() => Promise.reject(new ApiError('file_missing')));
    const outbox = new Outbox(vi.fn<Send>(never), () => undefined, timers, upload);
    outbox.sendFiles(agent, '', [
      {
        clientId: 'f1',
        uri: 'file:///a.pdf',
        name: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
      },
    ]);
    await settle();
    expect(outbox.list(agent)[0]).toMatchObject({ state: 'failed', errorCode: FILE_MISSING });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('a private voice note refused without consent cannot be retried', () => {
    expect(canRetry({ errorCode: 'private_thread', voice: {} })).toBe(false);
    expect(canRetry({ errorCode: 'private_thread', voice: { serverReadable: true } })).toBe(true);
    expect(
      canRetry({
        error: new ApiError('http', 'private_thread', undefined, undefined, 409),
        voice: {},
      }),
    ).toBe(false);
    expect(canRetry({ errorCode: 'agent_offline' })).toBe(true);
    expect(canRetry({ error: new ApiError('network') })).toBe(true);
  });

  it('a private message that retrying cannot fix offers Delete, not Retry', () => {
    for (const code of [
      'pair_again',
      'not_computer',
      'too_long',
      'file_too_large',
      'unsupported_file_type',
    ]) {
      expect(canRetry({ errorCode: code })).toBe(false);
    }
    expect(canRetry({ errorCode: 'seal_failed' })).toBe(true);
  });
});
