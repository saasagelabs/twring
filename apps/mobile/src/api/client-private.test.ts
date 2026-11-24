import { describe, expect, it } from 'vitest';

import { ApiError, createTwringApi } from './client';

const AGENT_ID = 'agt_abcdefghij0123456789';
const ENVELOPE = {
  v: 1,
  sender_device: 'dev_' + 'a'.repeat(20),
  sender_seq: 1,
  nonce: 'A'.repeat(32),
  body: 'B'.repeat(40),
  keys: [{ device: 'dev_' + 'a'.repeat(20), wrapped: 'C'.repeat(80) }],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createTwringApi({
    baseUrl: 'https://api.cord.invalid',
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(respond(url, init));
    },
  });
  const headers = (i: number) => calls[i]?.init.headers as Record<string, string>;
  return { api, calls, headers };
}

describe('private chats in the api client', () => {
  it('says the app can seal on every chat call', async () => {
    const { api, headers } = client((url) =>
      json(200, url.endsWith('/v1/threads') ? { threads: [] } : { messages: [], has_more: false }),
    );
    await api.listThreads();
    await api.listMessages(AGENT_ID);
    expect(headers(0)['x-twring-features']).toBe('sealed_chat');
    expect(headers(1)['x-twring-features']).toBe('sealed_chat');
  });

  it('posts a sealed body with no text', async () => {
    const message = {
      id: 'msg_' + 'a'.repeat(20),
      agent_id: AGENT_ID,
      seq: 1,
      rev: 1,
      created_at: '2026-11-25T00:00:00.000Z',
      updated_at: '2026-11-25T00:00:00.000Z',
      kind: 'sealed',
      author: 'user',
      client_id: '5f0c1b9e-8d7a-4c3b-9a2e-1f0e9d8c7b6a',
      sealed: [ENVELOPE],
    };
    const { api, calls } = client(() => json(201, { message }));
    await api.sendSealedMessage!(AGENT_ID, {
      clientId: message.client_id,
      sealed: ENVELOPE as never,
    });
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ client_id: message.client_id, sealed: ENVELOPE });
    expect(body).not.toHaveProperty('text');
  });

  it('turns a chat private with PUT { on: true } and the feature header', async () => {
    const { api, calls, headers } = client(() => json(200, { private: true }));
    await api.setPrivate!(AGENT_ID);
    expect(calls[0]?.url).toBe(`https://api.cord.invalid/v1/agents/${AGENT_ID}/private`);
    expect(calls[0]?.init.method).toBe('PUT');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ on: true });
    expect(headers(0)['x-twring-features']).toBe('sealed_chat');
  });

  it('keeps the machine code of a refusal', async () => {
    const { api } = client(() =>
      json(409, { error: { code: 'private_unsupported', message: 'x', request_id: 'r' } }),
    );
    await expect(api.setPrivate!(AGENT_ID)).rejects.toMatchObject({
      code: 'private_unsupported',
      status: 409,
    });
    await expect(api.setPrivate!(AGENT_ID)).rejects.toBeInstanceOf(ApiError);
  });

  it('learns private chats are on from a 200 on /v1/e2e/devices', async () => {
    const { api, calls } = client(() => json(200, { devices: [] }));
    await expect(api.privateChatsStatus!()).resolves.toBe('on');
    expect(calls[0]?.url).toBe('https://api.cord.invalid/v1/e2e/devices');
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('reads any 404 as off: private_chats_off or a bare 404', async () => {
    const coded = client(() =>
      json(404, { error: { code: 'private_chats_off', message: 'x', request_id: 'r' } }),
    );
    await expect(coded.api.privateChatsStatus!()).resolves.toBe('off');
    const bare = client(() => new Response('Not Found', { status: 404 }));
    await expect(bare.api.privateChatsStatus!()).resolves.toBe('off');
    const route = client(() => json(404, { message: 'Route GET:/v1/e2e/devices not found' }));
    await expect(route.api.privateChatsStatus!()).resolves.toBe('off');
  });

  it('reads a 5xx, a 429 or a network error as unknown', async () => {
    const down = client(() => json(503, { error: { code: 'x', message: 'x', request_id: 'r' } }));
    await expect(down.api.privateChatsStatus!()).resolves.toBe('unknown');
    const busy = client(() =>
      json(429, { error: { code: 'rate_limited', message: 'x', request_id: 'r' } }),
    );
    await expect(busy.api.privateChatsStatus!()).resolves.toBe('unknown');
    const offline = createTwringApi({
      baseUrl: 'https://api.cord.invalid',
      fetch: () => Promise.reject(new TypeError('Network request failed')),
    });
    await expect(offline.privateChatsStatus!()).resolves.toBe('unknown');
  });
});
