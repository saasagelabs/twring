import type { ThreadMessage } from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { newClientId, Outbox } from './outbox';

const agent = 'agt_abcdefghij0123456789';
const message = (clientId: string): ThreadMessage => ({
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
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('outbox', () => {
  afterEach(() => vi.useRealTimers());
  it('retries network failures at 1, 3, and 10 seconds with one client id', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<
        (
          agentId: string,
          request: { clientId: string; text: string },
          signal: AbortSignal,
        ) => Promise<ThreadMessage>
      >()
      .mockRejectedValue(new ApiError('network'));
    const box = new Outbox(send, () => undefined, timers);
    const id = box.send(agent, 'hello');
    await flush();
    for (const delay of [1_000, 3_000, 10_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(send.mock.calls.map((call) => call[1].clientId)).toEqual([id, id, id, id]);
    expect(box.list(agent)[0]?.state).toBe('failed');
    send.mockResolvedValueOnce(message(id));
    box.retry(id);
    await flush();
    expect(send.mock.calls.at(-1)?.[1].clientId).toBe(id);
    expect(box.list(agent)).toEqual([]);
  });
  it('does not retry ordinary 4xx and reconciles a socket message', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<
        (
          agentId: string,
          request: { clientId: string; text: string },
          signal: AbortSignal,
        ) => Promise<ThreadMessage>
      >()
      .mockRejectedValue(new ApiError('http', undefined, undefined, undefined, 400));
    const box = new Outbox(send, () => undefined, timers);
    const id = box.send(agent, 'hello');
    await flush();
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    box.reconcile(message(id));
    expect(box.list(agent)).toEqual([]);
  });
  it('waits until resets_at for 429', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T00:00:00.000Z'));
    const send = vi
      .fn<
        (
          agentId: string,
          request: { clientId: string; text: string },
          signal: AbortSignal,
        ) => Promise<ThreadMessage>
      >()
      .mockRejectedValueOnce(
        new ApiError('http', undefined, undefined, new Date(Date.now() + 4_000), 429),
      )
      .mockImplementationOnce((_agent, request) => Promise.resolve(message(request.clientId)));
    const box = new Outbox(send, () => undefined, timers);
    box.send(agent, 'hello');
    await flush();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('uploads in order, preserves upload ids on retry, then sends the message', async () => {
    const ids = ['fil_aaaaaaaaaaaaaaaaaaaa', 'fil_bbbbbbbbbbbbbbbbbbbb'];
    const uploaded: string[] = [];
    const send = vi.fn(
      (_agent: string, request: { clientId: string; text: string; attachmentIds?: string[] }) =>
        Promise.resolve(message(request.clientId)),
    );
    const upload = vi.fn((_agent: string, file: { clientId: string; name: string }) => {
      uploaded.push(file.clientId);
      if (file.name === 'second.pdf' && uploaded.length === 2)
        return Promise.reject(new ApiError('http', 'storage_full', undefined, undefined, 507));
      return Promise.resolve({
        id: ids[file.name === 'first.pdf' ? 0 : 1],
        name: file.name,
        mime_type: 'application/pdf' as const,
        size_bytes: 3,
      });
    });
    const box = new Outbox(send, () => undefined, timers, upload);
    const files = ['first.pdf', 'second.pdf'].map((name, index) => ({
      clientId: `file-${index}`,
      uri: `file:///${name}`,
      name,
      mimeType: 'application/pdf',
      sizeBytes: 3,
    }));
    const clientId = box.sendFiles(agent, '', files);
    await vi.waitFor(() => expect(box.list(agent)[0]?.state).toBe('failed'));
    expect(send).not.toHaveBeenCalled();
    expect(uploaded).toEqual(['file-0', 'file-1']);
    expect(box.list(agent)[0]?.files?.[0]?.uploaded?.id).toBe(ids[0]);
    box.retry(clientId);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(uploaded).toEqual(['file-0', 'file-1', 'file-1']);
    expect(send.mock.calls[0]?.[1].attachmentIds).toEqual(ids);
  });
  it('keeps voice notes on their existing request path', async () => {
    const send = vi.fn(
      (
        _agent: string,
        _request: { clientId: string; text: string; voice?: { uri: string; durationMs: number } },
      ) => Promise.reject(new ApiError('http', undefined, undefined, undefined, 400)),
    );
    const upload = vi.fn();
    const box = new Outbox(send, () => undefined, timers, upload);
    box.sendVoice(agent, 'file:///note.m4a', 5000);
    await vi.waitFor(() => expect(box.list(agent)[0]?.state).toBe('failed'));
    expect(send.mock.calls[0]?.[1].voice).toEqual({ uri: 'file:///note.m4a', durationMs: 5000 });
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('newClientId without Web Crypto (Hermes)', () => {
  it('makes a v4 uuid when crypto.getRandomValues is missing', () => {
    vi.stubGlobal('crypto', undefined);
    try {
      expect(newClientId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
