import type { ThreadMessage } from '@twring/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { FILE_MISSING, Outbox } from './outbox';
import { memoryStore, type OutboxFiles } from './outbox-storage';
import { messageStatus } from './presentation';

const agent = 'agt_abcdefghij0123456789';
const other = 'agt_zzzzzzzzzz0123456789';
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
const never = () => new Promise<never>(() => undefined);

/** Names copies like the device store: by the message's folder plus the file name. */
function memoryFiles(present: string[] = []): OutboxFiles & { present: Set<string> } {
  const files = {
    present: new Set(present),
    keep: (clientId: string, uri: string, key?: string) => {
      const kept = `doc://outbox/${clientId}/${key ? `${key}-` : ''}${uri.split('/').at(-1)}`;
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

describe('outbox verification', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("Clear chat drops that agent's queued messages, kept files and saved copy", async () => {
    const store = memoryStore();
    const files = memoryFiles(['cache://rec.m4a']);
    const send = vi.fn<Send>(never);
    const outbox = new Outbox(send, () => undefined, timers, undefined, {
      store,
      files: () => Promise.resolve(files),
    });
    await outbox.hydrated;
    outbox.sendVoice(agent, 'cache://rec.m4a', 4_000);
    outbox.send(other, 'keep me');
    await settle();
    await vi.advanceTimersByTimeAsync(300);
    await outbox.forgetAgent(agent);
    await settle();
    expect(outbox.list(agent)).toEqual([]);
    expect(outbox.list(other)).toHaveLength(1);
    expect(files.present.size).toBe(0);
    expect(
      (store.value as { items: { agentId: string }[] }).items.map((item) => item.agentId),
    ).toEqual([other]);
    const calls = send.mock.calls.filter(([id]) => id === agent).length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send.mock.calls.filter(([id]) => id === agent).length).toBe(calls);
  });

  it('sends nothing more once detach starts, even while the last write is slow', async () => {
    const store = memoryStore();
    let finishSave: () => void = () => undefined;
    const send = vi.fn<Send>(() => Promise.reject(new ApiError('network')));
    const outbox = new Outbox(send, () => undefined, timers, undefined, { store });
    await outbox.hydrated;
    outbox.send(agent, 'one');
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    store.save = () => new Promise<void>((resolve) => (finishSave = resolve));
    const detaching = outbox.detach();
    // The account switched; a retry firing now would send under the new account's sign-in.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(1);
    finishSave();
    await detaching;
    expect((store.value as { items: unknown[] } | undefined)?.items ?? []).toHaveLength(0);
  });

  it('keeps two attached files with the same name apart', async () => {
    const store = memoryStore();
    const files = memoryFiles(['a/photo.jpg', 'b/photo.jpg']);
    const outbox = new Outbox(vi.fn<Send>(never), () => undefined, timers, vi.fn(never), {
      store,
      files: () => Promise.resolve(files),
    });
    await outbox.hydrated;
    const file = { name: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 1 };
    outbox.sendFiles(agent, '', [
      { ...file, clientId: 'f1', uri: 'a/photo.jpg' },
      { ...file, clientId: 'f2', uri: 'b/photo.jpg' },
    ]);
    await settle();
    const uris = outbox.list(agent)[0].files!.map((item) => item.uri);
    expect(new Set(uris).size).toBe(2);
    expect(uris.every((uri) => files.present.has(uri))).toBe(true);
  });

  it('says in plain words that a queued file is gone', () => {
    const copy = messageStatus('failed', 'Hermes', FILE_MISSING);
    expect(copy).toContain('no longer on your phone');
    expect(copy).not.toContain('—');
  });
});
