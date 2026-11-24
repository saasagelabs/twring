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

  it('reads the server features, and none from an older server', async () => {
    const newer = client(() => json(200, { member: true, features: ['sealed_chat'] }));
    await expect(newer.api.serverFeatures!()).resolves.toEqual(['sealed_chat']);
    const older = client(() => json(200, { member: true }));
    await expect(older.api.serverFeatures!()).resolves.toEqual([]);
  });
});
