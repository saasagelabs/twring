import { describe, expect, it } from 'vitest';

import { ApiError } from './client';
import { apiErrorCopy } from './errors';
import { probeSpeechKeyError } from './speech-key-probe';

const body = (code: string, message: string) => ({
  error: { code, message, request_id: 'req-1' },
});

function fetchOf(status: number, payload: unknown, calls: unknown[] = []) {
  return (url: string, init: RequestInit) => {
    calls.push([url, init.headers]);
    return Promise.resolve(
      new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status }),
    );
  };
}

describe('probeSpeechKeyError', () => {
  it('turns a JSON error body into an ApiError carrying the server message', async () => {
    const calls: unknown[] = [];
    const error = await probeSpeechKeyError(
      fetchOf(
        409,
        body('speech_key_refused', 'Your Deepgram key was refused. Update it in Settings.'),
        calls,
      ),
      'https://api.test/v1/x',
      { authorization: 'Bearer t' },
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(apiErrorCopy(error).message).toBe(
      'Your Deepgram key was refused. Update it in Settings.',
    );
    expect(calls).toEqual([['https://api.test/v1/x', { authorization: 'Bearer t' }]]);
  });

  it('caps the server message at 200 characters', async () => {
    const error = await probeSpeechKeyError(
      fetchOf(409, body('speech_key_refused', 'x'.repeat(500))),
      'https://api.test/v1/x',
      {},
    );
    expect((error as ApiError).serverMessage).toHaveLength(200);
  });

  it('gives nothing for audio, non-JSON, unknown bodies or a failed probe', async () => {
    expect(await probeSpeechKeyError(fetchOf(200, 'RIFF'), 'u', {})).toBeUndefined();
    expect(await probeSpeechKeyError(fetchOf(502, '<html>'), 'u', {})).toBeUndefined();
    expect(await probeSpeechKeyError(fetchOf(400, { nope: 1 }), 'u', {})).toBeUndefined();
    expect(
      await probeSpeechKeyError(() => Promise.reject(new Error('offline')), 'u', {}),
    ).toBeUndefined();
  });

  it('cancels a healthy body so the audio is not made twice', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const doFetch = () => Promise.resolve(new Response(stream, { status: 200 }));
    expect(await probeSpeechKeyError(doFetch, 'u', {})).toBeUndefined();
    expect(cancelled).toBe(true);
  });

  it('a 2xx without a cancellable body is still fine', async () => {
    const doFetch = () =>
      Promise.resolve({ ok: true, status: 200, body: null } as unknown as Response);
    expect(await probeSpeechKeyError(doFetch, 'u', {})).toBeUndefined();
  });
});
