import { describe, expect, it, vi } from 'vitest';

import { PrerecordedTranscriptionError } from './deepgram-prerecorded';
import {
  XaiSynthesisError,
  createXaiTranscriber,
  fileName,
  synthesizeWithXai,
  transcribeWithXai,
} from './xai-rest';

const KEY = 'fake-xai-key-1234';
const AUDIO = new Uint8Array([1, 2, 3, 4]);

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn((url: string | URL, init?: RequestInit) => {
    calls.push({ url: url.toString(), init: init ?? {} });
    return Promise.resolve(respond());
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A fetch that never answers until its signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  ) as unknown as typeof fetch;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function expectNoKey(error: unknown) {
  expect(String(error)).not.toContain(KEY);
  expect(JSON.stringify(error)).not.toContain(KEY);
  if (error instanceof Error) expect(error.message).not.toContain(KEY);
}

describe('transcribeWithXai', () => {
  it('posts multipart to the fixed host with language, keyterms and file last', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      Response.json({ text: ' hello there ', language: 'en', duration: 1.2 }),
    );
    const text = await transcribeWithXai(KEY, AUDIO, 'audio/mp4', ['  Twring ', 'Grok', ''], {
      fetch: fetchImpl,
    });
    expect(text).toBe('hello there');
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.x.ai/v1/stt');
    expect(url).not.toContain(KEY);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(['language', 'keyterm', 'keyterm', 'file']);
    expect(form.get('language')).toBe('en');
    expect(form.getAll('keyterm')).toEqual(['Twring', 'Grok']);
    const file = form.get('file') as File;
    expect(file.type).toBe('audio/mp4');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(AUDIO);
  });

  it('keeps keyterms within 100 terms of 50 characters', async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ text: 'ok' }));
    const terms = ['x'.repeat(80), ...Array.from({ length: 150 }, (_, i) => `term${i}`)];
    await transcribeWithXai(KEY, AUDIO, 'audio/mp4', terms, { fetch: fetchImpl });
    const sent = (calls[0]!.init.body as FormData).getAll('keyterm') as string[];
    expect(sent).toHaveLength(100);
    expect(sent[0]).toBe('x'.repeat(50));
    expect(sent.every((t) => t.length <= 50)).toBe(true);
  });

  it.each([401, 402, 403, 500])('a %i keeps the status as provider_failure', async (status) => {
    const { fetchImpl } = fakeFetch(() => new Response(`bad key ${KEY}`, { status }));
    const error = await caught(
      transcribeWithXai(KEY, AUDIO, 'audio/mp4', [], { fetch: fetchImpl }),
    );
    expect(error).toBeInstanceOf(PrerecordedTranscriptionError);
    expect(error).toMatchObject({ code: 'provider_failure', status });
    expectNoKey(error);
  });

  it('empty text is empty', async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ text: '   ' }));
    const error = await caught(
      transcribeWithXai(KEY, AUDIO, 'audio/mp4', [], { fetch: fetchImpl }),
    );
    expect(error).toMatchObject({ code: 'empty' });
  });

  it('a malformed answer is a provider failure', async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ nope: true }));
    const error = await caught(
      transcribeWithXai(KEY, AUDIO, 'audio/mp4', [], { fetch: fetchImpl }),
    );
    expect(error).toMatchObject({ code: 'provider_failure' });
  });

  it('times out by aborting the request', async () => {
    const error = await caught(
      transcribeWithXai(KEY, AUDIO, 'audio/mp4', [], { fetch: hangingFetch(), timeoutMs: 10 }),
    );
    expect(error).toMatchObject({ code: 'timeout' });
    expectNoKey(error);
  });

  it('a caller abort ends the request as a provider failure', async () => {
    const controller = new AbortController();
    const pending = transcribeWithXai(KEY, AUDIO, 'audio/mp4', [], {
      fetch: hangingFetch(),
      signal: controller.signal,
    });
    controller.abort();
    expect(await caught(pending)).toMatchObject({ code: 'provider_failure' });
  });

  it('a network error never carries the key', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error(`connect failed Bearer ${KEY}`)),
    ) as unknown as typeof fetch;
    const error = await caught(
      transcribeWithXai(KEY, AUDIO, 'audio/mp4', [], { fetch: fetchImpl }),
    );
    expect(error).toMatchObject({ code: 'provider_failure' });
    expectNoKey(error);
  });
});

describe('synthesizeWithXai', () => {
  it('posts JSON for mp3 and returns the bytes', async () => {
    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    const { fetchImpl, calls } = fakeFetch(() => new Response(mp3, { status: 200 }));
    const bytes = await synthesizeWithXai(KEY, 'ara', 'Hello.', { fetch: fetchImpl });
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect([...bytes]).toEqual([...mp3]);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.x.ai/v1/tts');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Hello.',
      voice_id: 'ara',
      language: 'en',
      output_format: { codec: 'mp3' },
    });
  });

  it.each([401, 402, 403, 429, 500])('a %i keeps its status', async (status) => {
    const { fetchImpl } = fakeFetch(() => new Response(KEY, { status }));
    const error = await caught(synthesizeWithXai(KEY, 'eve', 'Hi', { fetch: fetchImpl }));
    expect(error).toBeInstanceOf(XaiSynthesisError);
    expect(error).toMatchObject({ code: 'provider_failure', status });
    expectNoKey(error);
  });

  it('no audio is empty', async () => {
    const { fetchImpl } = fakeFetch(() => new Response(new Uint8Array(), { status: 200 }));
    const error = await caught(synthesizeWithXai(KEY, 'eve', 'Hi', { fetch: fetchImpl }));
    expect(error).toMatchObject({ code: 'empty' });
  });

  it('times out by aborting the request', async () => {
    const error = await caught(
      synthesizeWithXai(KEY, 'eve', 'Hi', { fetch: hangingFetch(), timeoutMs: 10 }),
    );
    expect(error).toMatchObject({ code: 'timeout' });
    expectNoKey(error);
  });

  it('a network error never carries the key', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error(`Bearer ${KEY}`)),
    ) as unknown as typeof fetch;
    const error = await caught(synthesizeWithXai(KEY, 'eve', 'Hi', { fetch: fetchImpl }));
    expect(error).toMatchObject({ code: 'provider_failure' });
    expectNoKey(error);
  });
});

describe('voice note file name', () => {
  it.each([
    ['audio/mp4', 'audio.m4a'],
    ['audio/x-m4a', 'audio.m4a'],
    ['audio/m4a', 'audio.m4a'],
    ['audio/mpeg', 'audio.mp3'],
    ['application/octet-stream', 'audio'],
  ])('%s is sent as %s', async (type, name) => {
    expect(fileName(type)).toBe(name);
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ text: 'ok' }));
    await transcribeWithXai(KEY, AUDIO, type, [], { fetch: fetchImpl });
    expect(((calls[0]!.init.body as FormData).get('file') as File).name).toBe(name);
  });
});

describe('createXaiTranscriber retry policy', () => {
  function sequence(statuses: number[]) {
    const sent: string[][] = [];
    const fetchImpl = vi.fn((_url: string | URL, init?: RequestInit) => {
      sent.push((init?.body as FormData).getAll('keyterm') as string[]);
      const status = statuses.shift() ?? 200;
      return Promise.resolve(
        status === 200 ? Response.json({ text: 'heard' }) : new Response('no', { status }),
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, sent };
  }

  it.each([401, 402, 403])('a refused key (%i) is final: one request', async (status) => {
    const { fetchImpl, sent } = sequence([status]);
    const error = await caught(
      createXaiTranscriber(fetchImpl, 0)(KEY, AUDIO, 'audio/mp4', ['Twring']),
    );
    expect(error).toBeInstanceOf(PrerecordedTranscriptionError);
    expect((error as PrerecordedTranscriptionError).status).toBe(status);
    expect(sent).toHaveLength(1);
    expectNoKey(error);
  });

  it('a 4xx with keyterms goes again at once without them', async () => {
    const { fetchImpl, sent } = sequence([400]);
    const refused = vi.fn();
    const text = await createXaiTranscriber(fetchImpl, 60_000, refused)(KEY, AUDIO, 'audio/mp4', [
      'Twring',
    ]);
    expect(text).toBe('heard');
    expect(sent).toEqual([['Twring'], []]);
    expect(refused).toHaveBeenCalledWith(400);
  });

  it('a provider failure goes again once after the delay', async () => {
    const { fetchImpl, sent } = sequence([503]);
    expect(await createXaiTranscriber(fetchImpl, 1)(KEY, AUDIO, 'audio/mp4', [])).toBe('heard');
    expect(sent).toHaveLength(2);
    const twice = sequence([503, 502]);
    const error = await caught(createXaiTranscriber(twice.fetchImpl, 1)(KEY, AUDIO, 'audio/mp4'));
    expect((error as PrerecordedTranscriptionError).code).toBe('provider_failure');
    expect(twice.sent).toHaveLength(2);
  });

  it('an aborted note is not retried', async () => {
    const { fetchImpl, sent } = sequence([503]);
    const controller = new AbortController();
    const pending = createXaiTranscriber(fetchImpl, 50)(
      KEY,
      AUDIO,
      'audio/mp4',
      [],
      controller.signal,
    );
    controller.abort();
    await caught(pending);
    expect(sent.length).toBeLessThanOrEqual(1);
  });
});
