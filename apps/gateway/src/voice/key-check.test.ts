import { describe, expect, it, vi } from 'vitest';
import { checkSpeechKey } from './key-check.js';

const KEY = 'sk-secret-test-key-123456';

function fakeFetch(status: number) {
  return vi.fn((_url: unknown, _init?: RequestInit) =>
    Promise.resolve(new Response(null, { status })),
  );
}

describe('checkSpeechKey', () => {
  it('asks Deepgram with a Token header and no redirects', async () => {
    const f = fakeFetch(200);
    expect(await checkSpeechKey('deepgram', KEY, { fetch: f as unknown as typeof fetch })).toBe(
      'ok',
    );
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.deepgram.com/v1/projects');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({ Authorization: `Token ${KEY}` });
  });

  it('asks Cartesia with its key and version headers', async () => {
    const f = fakeFetch(200);
    expect(await checkSpeechKey('cartesia', KEY, { fetch: f as unknown as typeof fetch })).toBe(
      'ok',
    );
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.cartesia.ai/voices?limit=1');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({ 'X-API-Key': KEY, 'Cartesia-Version': '2026-08-14' });
  });

  it('asks xAI with a Bearer header, no redirects and a timeout', async () => {
    const f = fakeFetch(200);
    expect(await checkSpeechKey('xai', KEY, { fetch: f as unknown as typeof fetch })).toBe('ok');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.x.ai/v1/tts/voices');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it.each([
    [401, 'refused'],
    [402, 'refused'],
    [403, 'refused'],
    [404, 'unavailable'],
    [429, 'unavailable'],
    [500, 'unavailable'],
  ])('maps xAI %i to %s', async (status, expected) => {
    const f = fakeFetch(status);
    expect(await checkSpeechKey('xai', KEY, { fetch: f as unknown as typeof fetch })).toBe(
      expected,
    );
  });

  it.each([
    ['deepgram', 'api.deepgram.com'],
    ['cartesia', 'api.cartesia.ai'],
    ['xai', 'api.x.ai'],
  ] as const)('sends a %s key only to %s', async (provider, host) => {
    const f = fakeFetch(200);
    await checkSpeechKey(provider, KEY, { fetch: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(new URL(String(url)).host).toBe(host);
    expect(String(url)).not.toContain(KEY);
    expect(JSON.stringify(init?.headers)).toContain(KEY);
  });

  it.each([
    [401, 'refused'],
    [402, 'refused'],
    [403, 'refused'],
    [429, 'unavailable'],
    [500, 'unavailable'],
  ])('maps %i to %s', async (status, expected) => {
    const f = fakeFetch(status);
    expect(await checkSpeechKey('deepgram', KEY, { fetch: f as unknown as typeof fetch })).toBe(
      expected,
    );
  });

  it('treats xAI 400 "Incorrect API key provided" as a refused key', async () => {
    const body = JSON.stringify({
      code: 'Client specified an invalid argument',
      error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.',
    });
    const f = vi.fn(() => Promise.resolve(new Response(body, { status: 400 })));
    expect(await checkSpeechKey('xai', KEY, { fetch: f as unknown as typeof fetch })).toBe(
      'refused',
    );
  });

  it('keeps any other 400 unavailable', async () => {
    const answer = (body: string) =>
      vi.fn(() => Promise.resolve(new Response(body, { status: 400 })));
    const bad = answer('{"error":"invalid voice"}');
    expect(await checkSpeechKey('xai', KEY, { fetch: bad as unknown as typeof fetch })).toBe(
      'unavailable',
    );
    const deepgram = answer('Incorrect API key provided');
    expect(
      await checkSpeechKey('deepgram', KEY, { fetch: deepgram as unknown as typeof fetch }),
    ).toBe('unavailable');
  });

  it('reports unavailable when fetch throws, without leaking the key', async () => {
    const f = vi.fn(() => {
      return Promise.reject(new Error(`boom ${KEY}`));
    });
    const result = await checkSpeechKey('cartesia', KEY, { fetch: f as unknown as typeof fetch });
    expect(result).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('reports unavailable when the provider never answers', async () => {
    const f = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    expect(
      await checkSpeechKey('deepgram', KEY, { fetch: f as unknown as typeof fetch, timeoutMs: 20 }),
    ).toBe('unavailable');
  });
});
