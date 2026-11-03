import { describe, expect, it, vi } from 'vitest';

import { runCheckSpeechKey } from './check-speech-key';

const KEY = 'dg-secret-key-0123456789';

function run(env: Record<string, string | undefined>, status: number | 'throw') {
  const lines: string[] = [];
  const fetch = vi.fn(() =>
    status === 'throw'
      ? Promise.reject(new Error('network down'))
      : Promise.resolve(new Response('{}', { status })),
  );
  const code = runCheckSpeechKey(env, {
    fetch: fetch as unknown as typeof globalThis.fetch,
    out: (t) => lines.push(t),
  });
  return { code, lines, fetch };
}

describe('check-speech-key', () => {
  it.each([
    ['deepgram', 200, 0],
    ['xai', 200, 0],
    ['deepgram', 401, 2],
    ['xai', 403, 2],
    ['deepgram', 503, 3],
    ['xai', 'throw', 3],
  ] as const)('%s answering %s exits %i', async (provider, status, expected) => {
    const { code, lines, fetch } = run(
      { TWRING_SPEECH_PROVIDER: provider, TWRING_SPEECH_KEY: KEY },
      status,
    );
    expect(await code).toBe(expected);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('asks the chosen provider host only', async () => {
    const { code, fetch } = run({ TWRING_SPEECH_PROVIDER: 'xai', TWRING_SPEECH_KEY: KEY }, 200);
    await code;
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(/^https:\/\/api\.x\.ai\//);
  });

  it.each([
    [{ TWRING_SPEECH_PROVIDER: 'deepgram' }],
    [{ TWRING_SPEECH_PROVIDER: 'deepgram', TWRING_SPEECH_KEY: '  ' }],
    [{ TWRING_SPEECH_KEY: KEY }],
    [{ TWRING_SPEECH_PROVIDER: 'cartesia', TWRING_SPEECH_KEY: KEY }],
  ])('refuses bad input %j with exit 64 and no request', async (env) => {
    const { code, lines, fetch } = run(env, 200);
    expect(await code).toBe(64);
    expect(fetch).not.toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain(KEY);
  });
});
