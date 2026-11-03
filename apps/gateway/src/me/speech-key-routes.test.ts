import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { loadGatewayEnv } from '@twring/config/gateway';
import {
  deleteMyDataResponseSchema,
  errorResponseSchema,
  speechKeyListResponseSchema,
} from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import { AuthError, createRequestAuth } from '../auth';
import { createLoggerOptions } from '../logger';
import { StoreCorruptError } from '../store/collection';
import { createMemoryStores } from '../store/repositories';
import type { KeyCheckResult } from '../voice/key-check';

const keys = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 9).toString('base64')]]) };
const KEY = 'sk-test-ABCDEFGHIJKLMNOP1234';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0)) await task();
});

async function server(
  options: {
    enabled?: boolean;
    result?: KeyCheckResult;
    rate?: number;
    check?: () => Promise<KeyCheckResult>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'cord-speech-keys-'));
  const env = loadGatewayEnv(gatewayEnvFixture({ CORD_DATA_DIR: dir, LOG_LEVEL: 'trace' }));
  const stores = createMemoryStores(keys);
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const app = buildApp({
    env,
    logger: { ...createLoggerOptions(env), stream: sink },
    agents: {
      stores,
      policy: { env: 'development', lookup: () => Promise.resolve([]) },
      writeRatePerMinute: 100,
    },
    me: { deleteRatePerMinute: 100 },
    speechKeys: {
      enabled: options.enabled ?? true,
      writeRatePerMinute: options.rate ?? 5,
      check: options.check ?? (() => Promise.resolve(options.result ?? 'ok')),
    },
    auth: createRequestAuth((request) => {
      const token = request.headers.authorization;
      if (!token) throw new AuthError(401, 'auth_required', 'Sign in.');
      const user = token === 'Bearer bob' ? 'bob' : 'alice';
      return Promise.resolve({ id: user, email: `${user}@example.com` });
    }),
    onError: () => undefined,
  });
  cleanup.push(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, who = 'alice', payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${who}` },
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });
  const put = (provider: string, payload: unknown = { key: KEY }, who = 'alice') =>
    call('PUT', `/v1/me/speech-keys/${provider}`, who, payload);
  return { app, stores, call, put, lines };
}

describe('/v1/me/speech-keys', () => {
  it('lists every provider with nothing added', async () => {
    const { call } = await server();
    const res = await call('GET', '/v1/me/speech-keys');
    expect(res.statusCode).toBe(200);
    expect(speechKeyListResponseSchema.parse(res.json()).providers).toEqual([
      { provider: 'deepgram', added: null },
      { provider: 'cartesia', added: null },
      { provider: 'xai', added: null },
    ]);
  });

  it('saves a checked key, shows only its last four, and keeps it per person', async () => {
    const { call, put, stores } = await server();
    const saved = await put('deepgram');
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(KEY);
    const list = speechKeyListResponseSchema.parse(
      (await call('GET', '/v1/me/speech-keys')).json(),
    );
    expect(list.providers[0]?.added?.last4).toBe(KEY.slice(-4));
    expect(list.providers[1]?.added).toBeNull();
    expect(await stores.speechKeys.get('alice', 'deepgram')).toBe(KEY);
    const bob = speechKeyListResponseSchema.parse(
      (await call('GET', '/v1/me/speech-keys', 'bob')).json(),
    );
    expect(bob.providers.every((p) => p.added === null)).toBe(true);
  });

  it('saves nothing when the provider refuses the key', async () => {
    const { put, stores } = await server({ result: 'refused' });
    const res = await put('cartesia');
    expect(res.statusCode).toBe(422);
    expect(errorResponseSchema.parse(res.json()).error).toMatchObject({
      code: 'speech_key_refused',
      message: 'Cartesia refused this key. Check it in your Cartesia account.',
    });
    expect(res.body).not.toContain(KEY);
    expect(await stores.speechKeys.list('alice')).toEqual([]);
  });

  it('saves nothing when the provider cannot be reached', async () => {
    const { put, stores } = await server({ result: 'unavailable' });
    const res = await put('deepgram');
    expect(res.statusCode).toBe(503);
    expect(errorResponseSchema.parse(res.json()).error).toMatchObject({
      code: 'speech_key_check_failed',
      message: "Couldn't reach Deepgram to check the key. Try again.",
    });
    expect(await stores.speechKeys.list('alice')).toEqual([]);
  });

  it('rejects a malformed body and an unknown provider', async () => {
    const { put } = await server();
    const bad = await put('deepgram', { key: 'short' });
    expect(bad.statusCode).toBe(400);
    expect(errorResponseSchema.parse(bad.json()).error).toMatchObject({
      code: 'speech_key_invalid',
      message: "That doesn't look like a key. Paste it again.",
    });
    const unknown = await put('openai');
    expect(unknown.statusCode).toBe(404);
    expect(errorResponseSchema.parse(unknown.json()).error.code).toBe('not_found');
  });

  it('limits saves per person per minute', async () => {
    const { put } = await server({ rate: 5 });
    for (let i = 0; i < 5; i += 1) expect((await put('deepgram')).statusCode).toBe(200);
    const sixth = await put('deepgram');
    expect(sixth.statusCode).toBe(429);
    expect(errorResponseSchema.parse(sixth.json()).error.code).toBe('rate_limited');
  });

  it('deletes a key, and answers 204 when there is none', async () => {
    const { call, put, stores } = await server();
    await put('deepgram');
    expect((await call('DELETE', '/v1/me/speech-keys/deepgram')).statusCode).toBe(204);
    expect(await stores.speechKeys.list('alice')).toEqual([]);
    expect((await call('DELETE', '/v1/me/speech-keys/deepgram')).statusCode).toBe(204);
  });

  it('answers 404 speech_keys_disabled to list and save when the switch is off', async () => {
    const { call, put } = await server({ enabled: false });
    const responses = [await call('GET', '/v1/me/speech-keys'), await put('deepgram')];
    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect(errorResponseSchema.parse(res.json()).error.code).toBe('speech_keys_disabled');
    }
  });

  it('still removes a key saved while the switch was on', async () => {
    const { call, stores } = await server({ enabled: false });
    await stores.speechKeys.put('alice', 'deepgram', KEY, new Date());
    expect((await call('DELETE', '/v1/me/speech-keys/deepgram')).statusCode).toBe(204);
    expect(await stores.speechKeys.list('alice')).toEqual([]);
    expect((await call('DELETE', '/v1/me/speech-keys/openai')).statusCode).toBe(404);
  });

  it('a save whose check ends after Delete my data stores nothing', async () => {
    let finish: (result: KeyCheckResult) => void = () => undefined;
    const { call, put, stores } = await server({
      check: () => new Promise<KeyCheckResult>((resolve) => (finish = resolve)),
    });
    const saving = put('deepgram');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await call('DELETE', '/v1/me/data')).statusCode).toBe(200);
    finish('ok');
    const res = await saving;
    expect(res.statusCode).toBe(409);
    expect(errorResponseSchema.parse(res.json()).error).toMatchObject({
      code: 'speech_key_check_failed',
      message: "Couldn't save the key. Try again.",
    });
    expect(await stores.speechKeys.list('alice')).toEqual([]);
    // Bob's save is not touched by Alice's deletion.
    const bobSaving = put('deepgram', { key: KEY }, 'bob');
    await new Promise((resolve) => setTimeout(resolve, 10));
    finish('ok');
    expect((await bobSaving).statusCode).toBe(200);
  });

  it('Delete my data removes speech keys and reports how many', async () => {
    const { call, put, stores } = await server();
    await put('deepgram');
    const res = await call('DELETE', '/v1/me/data');
    expect(res.statusCode).toBe(200);
    expect(deleteMyDataResponseSchema.parse(res.json()).deleted.speech_keys).toBe(1);
    expect(await stores.speechKeys.list('alice')).toEqual([]);
  });

  it.each(['ok', 'refused'] as const)(
    'never logs or returns the key (check %s)',
    async (result) => {
      const { call, put, lines } = await server({ result });
      const res = await put('deepgram');
      const bodies = [res.body, (await call('GET', '/v1/me/speech-keys')).body];
      for (const body of bodies) expect(body).not.toContain(KEY);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toContain(KEY);
    },
  );
});

describe('/v1/me/speech-keys xAI and the listening choice', () => {
  const list = async (call: Awaited<ReturnType<typeof server>>['call'], who = 'alice') =>
    speechKeyListResponseSchema.parse((await call('GET', '/v1/me/speech-keys', who)).json());
  const listen = (
    call: Awaited<ReturnType<typeof server>>['call'],
    payload: unknown,
    who = 'alice',
  ) => call('PUT', '/v1/me/speech-keys/listening', who, payload);

  it('lets a person add both keys and switch listening a few times in one minute', async () => {
    const { call, put } = await server({ rate: 5 });
    expect((await put('deepgram')).statusCode).toBe(200);
    expect((await put('xai')).statusCode).toBe(200);
    for (const provider of ['xai', 'deepgram', 'xai', 'deepgram', 'xai', 'deepgram']) {
      expect((await listen(call, { provider })).statusCode).toBe(200);
    }
    // Saves keep their own, lower limit: switching never uses it up.
    for (let i = 0; i < 3; i += 1) expect((await put('deepgram')).statusCode).toBe(200);
    expect((await put('deepgram')).statusCode).toBe(429);
  });

  it('still limits listening switches per person per minute', async () => {
    const { call, put } = await server({ rate: 5 });
    await put('deepgram');
    await put('xai');
    for (let i = 0; i < 30; i += 1) await listen(call, { provider: i % 2 ? 'xai' : 'deepgram' });
    const next = await listen(call, { provider: 'xai' });
    expect(next.statusCode).toBe(429);
    expect(errorResponseSchema.parse(next.json()).error.code).toBe('rate_limited');
  });

  it('saves, lists and removes an xAI key', async () => {
    const { call, put, stores } = await server();
    const saved = await put('xai');
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(KEY);
    expect((await list(call)).providers[2]).toMatchObject({
      provider: 'xai',
      added: { last4: KEY.slice(-4) },
    });
    expect(await stores.speechKeys.get('alice', 'xai')).toBe(KEY);
    expect((await call('DELETE', '/v1/me/speech-keys/xai')).statusCode).toBe(204);
    expect(await stores.speechKeys.list('alice')).toEqual([]);
  });

  it('names xAI in its refusal and unreachable copy', async () => {
    const refused = await (await server({ result: 'refused' })).put('xai');
    expect(errorResponseSchema.parse(refused.json()).error.message).toBe(
      'xAI refused this key. Check it in your xAI account.',
    );
    const down = await (await server({ result: 'unavailable' })).put('xai');
    expect(errorResponseSchema.parse(down.json()).error.message).toBe(
      "Couldn't reach xAI to check the key. Try again.",
    );
  });

  it('lists listening as deepgram, with no choice until both keys exist', async () => {
    const { call, put } = await server();
    expect(await list(call)).toMatchObject({ listening: 'deepgram', listening_choice: false });
    await put('xai');
    expect(await list(call)).toMatchObject({ listening: 'xai', listening_choice: false });
    await put('deepgram');
    expect(await list(call)).toMatchObject({ listening: 'deepgram', listening_choice: true });
  });

  it('keeps cartesia out of the choice', async () => {
    const { call, put } = await server();
    await put('cartesia');
    await put('xai');
    expect((await list(call)).listening_choice).toBe(false);
  });

  it('sets listening when that provider has a key, and returns the list', async () => {
    const { call, put } = await server();
    await put('xai');
    await put('deepgram');
    const res = await listen(call, { provider: 'xai' });
    expect(res.statusCode).toBe(200);
    expect(speechKeyListResponseSchema.parse(res.json())).toMatchObject({
      listening: 'xai',
      listening_choice: true,
    });
    expect((await list(call, 'bob')).listening).toBe('deepgram');
  });

  it.each([
    ['xai', 'Add an xAI key first.'],
    ['deepgram', 'Add a Deepgram key first.'],
  ])('refuses %s listening without its key', async (provider, message) => {
    const { call, stores } = await server();
    const res = await listen(call, { provider });
    expect(res.statusCode).toBe(400);
    expect(errorResponseSchema.parse(res.json()).error).toMatchObject({
      code: 'bad_request',
      message,
    });
    expect(await stores.speechKeys.getListening('alice')).toBe('deepgram');
  });

  it.each([{ provider: 'cartesia' }, {}, { provider: 'xai', extra: 1 }])(
    'rejects the invalid listening body %j',
    async (payload) => {
      const { call, put } = await server();
      await put('xai');
      const res = await listen(call, payload);
      expect(res.statusCode).toBe(400);
      expect(errorResponseSchema.parse(res.json()).error.code).toBe('bad_request');
    },
  );

  it('removing the chosen provider key returns listening to the other', async () => {
    const { call, put } = await server();
    await put('xai');
    await put('deepgram');
    await listen(call, { provider: 'xai' });
    await call('DELETE', '/v1/me/speech-keys/xai');
    expect(await list(call)).toMatchObject({ listening: 'deepgram', listening_choice: false });
  });

  it('answers 404 speech_keys_disabled to the listening choice when the switch is off', async () => {
    const { call } = await server({ enabled: false });
    const res = await listen(call, { provider: 'xai' });
    expect(res.statusCode).toBe(404);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('speech_keys_disabled');
  });

  it('Delete my data clears the listening choice', async () => {
    const { call, put, stores } = await server();
    await put('xai');
    await put('deepgram');
    await listen(call, { provider: 'xai' });
    expect((await call('DELETE', '/v1/me/data')).statusCode).toBe(200);
    expect(await stores.speechKeys.getListening('alice')).toBe('deepgram');
  });
});

describe('listening choice races and routing', () => {
  async function gated() {
    const made = await server();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = made.stores.speechKeys.list.bind(made.stores.speechKeys);
    let armed = false;
    vi.spyOn(made.stores.speechKeys, 'list').mockImplementation(async (userId) => {
      const rows = await real(userId);
      if (armed) {
        armed = false;
        await gate;
      }
      return rows;
    });
    return { ...made, release, arm: () => (armed = true) };
  }

  it('a choice whose xAI key is removed meanwhile does not stick', async () => {
    const { call, put, stores, release, arm } = await gated();
    await put('xai');
    await put('deepgram');
    arm();
    const choosing = call('PUT', '/v1/me/speech-keys/listening', 'alice', { provider: 'xai' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await call('DELETE', '/v1/me/speech-keys/xai')).statusCode).toBe(204);
    release();
    const res = await choosing;
    expect([200, 409]).toContain(res.statusCode);
    expect(await stores.speechKeys.getListening('alice')).toBe('deepgram');
    const after = speechKeyListResponseSchema.parse(
      (await call('GET', '/v1/me/speech-keys')).json(),
    );
    expect(after.listening).toBe('deepgram');
  });

  it('a choice that ends after Delete my data stores nothing', async () => {
    const { call, put, stores, release, arm } = await gated();
    await put('xai');
    arm();
    const choosing = call('PUT', '/v1/me/speech-keys/listening', 'alice', { provider: 'xai' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await call('DELETE', '/v1/me/data')).statusCode).toBe(200);
    release();
    const res = await choosing;
    expect(res.statusCode).toBe(409);
    expect(errorResponseSchema.parse(res.json()).error).toMatchObject({
      code: 'speech_key_check_failed',
      message: "Couldn't save the choice. Try again.",
    });
    expect(await stores.speechKeys.getListening('alice')).toBe('deepgram');
    expect(await stores.speechKeys.list('alice')).toEqual([]);
  });

  it('DELETE on the listening path is not a provider', async () => {
    const { call } = await server();
    const res = await call('DELETE', '/v1/me/speech-keys/listening');
    expect(res.statusCode).toBe(404);
  });
});

describe('listening choice on an unreadable settings file', () => {
  it('answers 503 service_unavailable instead of 500', async () => {
    const { call, put, stores } = await server();
    await put('xai');
    vi.spyOn(stores.speechKeys, 'setListening').mockRejectedValue(
      new StoreCorruptError('speech-settings.json'),
    );
    const res = await call('PUT', '/v1/me/speech-keys/listening', 'alice', { provider: 'xai' });
    expect(res.statusCode).toBe(503);
    expect(errorResponseSchema.parse(res.json()).error).toMatchObject({
      code: 'service_unavailable',
      message: "Couldn't save the choice. Try again later.",
    });
  });
});
