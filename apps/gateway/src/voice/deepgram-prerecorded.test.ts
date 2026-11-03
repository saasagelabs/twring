import { describe, expect, it, vi } from 'vitest';
import { createPrerecordedTranscriber } from './deepgram-prerecorded';
import type { PrerecordedTranscriptionError } from './deepgram-prerecorded';

const audio = new Uint8Array([1, 2, 3]);
const answer = (transcript: string) =>
  new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript }] }] } }), {
    status: 200,
  });

describe('prerecorded Deepgram transcription', () => {
  it('sends the raw audio with auth and required query, and trims the transcript', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer(' hello '));
    expect(await createPrerecordedTranscriber('secret', fetcher)(audio, 'audio/mp4')).toBe('hello');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=en',
    );
    expect(init?.headers).toEqual({ Authorization: 'Token secret', 'Content-Type': 'audio/mp4' });
    expect(init?.method).toBe('POST');
    expect(init?.body).toEqual(Buffer.from(audio));
  });

  it('listens for the agent’s words, each as its own keyterm', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer('hi Gowri'));
    await createPrerecordedTranscriber('secret', fetcher)(audio, 'audio/mp4', undefined, [
      'Gowri',
      'Light sail',
    ]);
    expect(fetcher.mock.calls[0]![0]).toBe(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=en&keyterm=Gowri&keyterm=Light+sail',
    );
  });

  it('a word list the provider refuses never costs the voice note: it goes again without', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"err_msg":"too many keyterm tokens"}', { status: 400 }))
      .mockResolvedValueOnce(answer('hi there'));
    const dropped: number[] = [];
    const transcribe = createPrerecordedTranscriber('secret', fetcher, 60_000, (status) =>
      dropped.push(status),
    );
    expect(await transcribe(audio, 'audio/mp4', undefined, ['Gowri'])).toBe('hi there');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).not.toContain('keyterm');
    expect(dropped).toEqual([400]);
  });

  it('a refusal without words is a failure, as before', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 400 }));
    await expect(
      createPrerecordedTranscriber('secret', fetcher, 0)(audio, 'audio/mp4'),
    ).rejects.toMatchObject({ code: 'provider_failure' });
  });
  it('rejects an empty transcript', async () => {
    await expect(
      createPrerecordedTranscriber('key', vi.fn<typeof fetch>().mockResolvedValue(answer('  ')))(
        audio,
        'audio/mp4',
      ),
    ).rejects.toMatchObject({ code: 'empty' } satisfies Partial<PrerecordedTranscriptionError>);
  });
  it('retries a provider error once, then gives up', async () => {
    const failing = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 500 }));
    await expect(
      createPrerecordedTranscriber('key', failing, 0)(audio, 'audio/mp4'),
    ).rejects.toMatchObject({ code: 'provider_failure' });
    expect(failing).toHaveBeenCalledTimes(2);
    const flaky = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(answer('second try'));
    expect(await createPrerecordedTranscriber('key', flaky, 0)(audio, 'audio/mp4')).toBe(
      'second try',
    );
  });
  it('does not retry an empty transcript', async () => {
    const empty = vi.fn<typeof fetch>().mockResolvedValue(answer(''));
    await expect(
      createPrerecordedTranscriber('key', empty, 0)(audio, 'audio/mp4'),
    ).rejects.toMatchObject({ code: 'empty' });
    expect(empty).toHaveBeenCalledTimes(1);
  });
  it('times out after 30 seconds', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const result = createPrerecordedTranscriber('key', fetcher)(audio, 'audio/mp4');
      const assertion = expect(result).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('prerecorded transcription with a person’s own key', () => {
  it('sends the key given for this note instead of the server key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer('hi'));
    await createPrerecordedTranscriber('server-key', fetcher)(
      audio,
      'audio/mp4',
      undefined,
      [],
      'own-key',
    );
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: 'Token own-key' });
  });

  it.each([401, 402, 403])(
    'a refused key (%i) is not retried, with or without words',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status }));
      const onKeytermsRefused = vi.fn();
      const transcribe = createPrerecordedTranscriber('k', fetcher, 0, onKeytermsRefused);
      await expect(transcribe(audio, 'audio/mp4', undefined, ['Gowri'])).rejects.toMatchObject({
        code: 'provider_failure',
        status,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(onKeytermsRefused).not.toHaveBeenCalled();
    },
  );
});
