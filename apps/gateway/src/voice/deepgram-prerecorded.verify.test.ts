import { describe, expect, it, vi } from 'vitest';

import { createPrerecordedTranscriber } from './deepgram-prerecorded';

const audio = new Uint8Array([1, 2, 3]);
const answer = (transcript: string) =>
  new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript }] }] } }), {
    status: 200,
  });
const hang = (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });

describe('prerecorded transcription failure paths', () => {
  it('a provider 5xx twice is one retry (two calls) and then provider_failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 502 }));
    await expect(
      createPrerecordedTranscriber('k', fetcher, 0)(audio, 'audio/mp4'),
    ).rejects.toMatchObject({ code: 'provider_failure' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('a dropped connection is retried once', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(answer('ok'));
    expect(await createPrerecordedTranscriber('k', fetcher, 0)(audio, 'audio/mp4')).toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('a malformed 200 body is a provider failure (retried once), not a crash', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response('not json', { status: 200 })));
    await expect(
      createPrerecordedTranscriber('k', fetcher, 0)(audio, 'audio/mp4'),
    ).rejects.toMatchObject({ code: 'provider_failure' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('a timeout is not retried', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(hang);
      const result = createPrerecordedTranscriber('k', fetcher, 0)(audio, 'audio/mp4');
      const assertion = expect(result).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a timeout on the retry attempt also ends with timeout and no third call', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockImplementation(hang);
      const result = createPrerecordedTranscriber('k', fetcher, 500)(audio, 'audio/mp4');
      const assertion = expect(result).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(500 + 30_001);
      await assertion;
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a caller abort is not retried and clears the timer', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(hang);
      const controller = new AbortController();
      const result = createPrerecordedTranscriber('k', fetcher, 0)(
        audio,
        'audio/mp4',
        controller.signal,
      );
      const assertion = expect(result).rejects.toMatchObject({ code: 'provider_failure' });
      controller.abort();
      await assertion;
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an abort during the retry delay stops before the second call', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 500 }));
      const controller = new AbortController();
      const result = createPrerecordedTranscriber('k', fetcher, 500)(
        audio,
        'audio/mp4',
        controller.signal,
      );
      const assertion = expect(result).rejects.toMatchObject({ code: 'provider_failure' });
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('error messages never carry the api key, audio, or transcript', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('boom SECRETKEY'));
    const error = await createPrerecordedTranscriber(
      'SECRETKEY',
      fetcher,
      0,
    )(audio, 'audio/mp4').then(
      () => new Error('did not fail'),
      (e: unknown) => e as Error,
    );
    expect(error.message).not.toContain('SECRETKEY');
    expect(JSON.stringify(error)).not.toContain('SECRETKEY');
  });
});
