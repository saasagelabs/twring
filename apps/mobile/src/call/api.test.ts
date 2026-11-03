import { describe, expect, it } from 'vitest';

import { CallApiError, createCallApi } from './api';

const SESSION = {
  call_id: 'call_abcdefghij0123456789',
  session_id: 'sess_abcdefghij0123456789',
  livekit: { url: 'wss://cord-test.livekit.invalid', token: 'jwt', room: 'cord-call-x' },
  expires_at: '2026-09-25T10:00:00.000Z',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function api(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  requireSecureMedia = true,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createCallApi({
    baseUrl: 'https://api.cord.invalid/',
    requireSecureMedia,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(respond(url, init));
    },
  });
  return { client, calls };
}

const signal = () => new AbortController().signal;

describe('call api', () => {
  it('creates a call with an empty JSON body and validates the response', async () => {
    const { client, calls } = api(() => jsonResponse(201, SESSION));
    await expect(client.create(signal())).resolves.toEqual(SESSION);
    expect(calls[0]?.url).toBe('https://api.cord.invalid/v1/calls');
    expect(calls[0]?.init.body).toBe('{}');
  });

  it('sends the saved agent id when calling an agent', async () => {
    const { client, calls } = api(() => jsonResponse(201, SESSION));
    await client.create(signal(), { agent_id: 'agt_abcdefghij0123456789' });
    expect(calls[0]?.init.body).toBe('{"agent_id":"agt_abcdefghij0123456789"}');
  });

  it('refuses an insecure media URL when secure media is required', async () => {
    const insecure = { ...SESSION, livekit: { ...SESSION.livekit, url: 'ws://10.0.2.2:7880' } };
    await expect(api(() => jsonResponse(201, insecure)).client.create(signal())).rejects.toEqual(
      new CallApiError('invalid_response'),
    );
    await expect(
      api(() => jsonResponse(201, insecure), false).client.create(signal()),
    ).resolves.toBeDefined();
  });

  it('surfaces the stable error code and request ID, not the server message', async () => {
    const { client } = api(() =>
      jsonResponse(503, {
        error: { code: 'capacity_exceeded', message: 'internal detail', request_id: 'req-1' },
      }),
    );
    const error = await client.create(signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallApiError);
    expect(error).toMatchObject({ kind: 'http', code: 'capacity_exceeded', requestId: 'req-1' });
    expect((error as Error).message).not.toContain('internal detail');
  });

  it('classifies network failures and malformed bodies', async () => {
    const offline = createCallApi({
      baseUrl: 'https://api.cord.invalid',
      requireSecureMedia: true,
      fetch: () => Promise.reject(new TypeError('Network request failed')),
    });
    await expect(offline.create(signal())).rejects.toMatchObject({ kind: 'network' });
    await expect(
      api(() => new Response('<html>', { status: 502 })).client.create(signal()),
    ).rejects.toMatchObject({ kind: 'http' });
    await expect(
      api(() => jsonResponse(201, { call_id: 'nope' })).client.create(signal()),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('ends a call at its URL-encoded path', async () => {
    const { client, calls } = api(() => jsonResponse(200, { call_id: SESSION.call_id }));
    await client.end(SESSION.call_id, signal());
    expect(calls[0]?.url).toBe(`https://api.cord.invalid/v1/calls/${SESSION.call_id}/end`);
  });
});

describe("call api on a person's own server", () => {
  it('follows no redirect there, and hosted requests are unchanged', async () => {
    const inits: RequestInit[] = [];
    const fetch = (_url: string, init: RequestInit) => {
      inits.push(init);
      return Promise.resolve(jsonResponse(201, SESSION));
    };
    const own = createCallApi({
      baseUrl: 'https://h.example.com',
      requireSecureMedia: true,
      fetch,
      rejectRedirects: true,
    });
    await own.create(signal());
    expect(inits[0]?.redirect).toBe('error');
    const hosted = createCallApi({ baseUrl: 'https://a.invalid', requireSecureMedia: true, fetch });
    await hosted.create(signal());
    expect(inits[1]?.redirect).toBeUndefined();
  });
});
