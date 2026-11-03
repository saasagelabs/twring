import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadGatewayEnv } from '@twring/config/gateway';
import { agentSchema } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import { AuthError, createRequestAuth } from '../auth';
import { createMemoryStores } from '../store/repositories';
import { AvatarStore } from './avatars';

const keys = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 9).toString('base64')]]) };
const id = `agt_${'a'.repeat(20)}`;
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanup.splice(0)) await task();
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cord-avatars-'));
  const stores = createMemoryStores(keys);
  const avatars = new AvatarStore(dir, keys);
  const app = buildApp({
    env: loadGatewayEnv(gatewayEnvFixture({ CORD_DATA_DIR: dir })),
    agents: {
      stores,
      avatars,
      policy: {
        env: 'development',
        lookup: () => Promise.resolve([{ address: '93.184.215.14', family: 4 }]),
      },
      writeRatePerMinute: 100,
    },
    me: { deleteRatePerMinute: 100 },
    auth: createRequestAuth((request) => {
      const token = request.headers.authorization;
      if (!token) throw new AuthError(401, 'auth_required', 'Sign in.');
      return Promise.resolve(token === 'Bearer other' ? 'other' : 'alice');
    }),
    onError: () => undefined,
  });
  cleanup.push(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  await stores.agents.create({
    id,
    user_id: 'alice',
    name: 'Agent',
    protocol: 'cord-rest',
    endpoint_url: 'https://example.com/agent',
    voice_id: 'flux-haley-en',
    status: 'ready',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const path = `/v1/agents/${id}/avatar`;
  const file = join(dir, 'avatars', 'alice', `${id}.bin`);
  const send = (
    method: 'GET' | 'PUT' | 'DELETE',
    url = path,
    payload?: Buffer,
    authorization = 'Bearer alice',
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization, ...headers },
      ...(payload && { payload }),
    });
  return { app, send, file, path };
}

describe('agent photos', () => {
  it('stores encrypted JPEGs, serves versioned bytes, replaces and removes them', async () => {
    const { send, file } = await setup();
    const first = await send('PUT', undefined, jpeg, undefined, { 'content-type': 'image/jpeg' });
    expect(first.statusCode).toBe(200);
    const version = agentSchema.parse(first.json()).avatar_version;
    expect(version).toBeGreaterThan(0);
    if (version === undefined) throw new Error('Photo version missing');
    const stored = await readFile(file);
    expect(stored).not.toEqual(jpeg);
    expect(stored.subarray(0, 3)).not.toEqual(jpeg.subarray(0, 3));
    const get = await send('GET');
    expect(get.rawPayload).toEqual(jpeg);
    expect(get.headers['content-type']).toBe('image/jpeg');
    expect(get.headers['cache-control']).toBe('private, max-age=86400');
    expect(get.headers.etag).toBe(`"${version}"`);
    expect(
      (await send('GET', undefined, undefined, undefined, { 'if-none-match': `"${version}"` }))
        .statusCode,
    ).toBe(304);
    const second = await send('PUT', undefined, jpeg, undefined, { 'content-type': 'image/jpeg' });
    const secondVersion = agentSchema.parse(second.json()).avatar_version;
    expect(secondVersion).toBeDefined();
    if (secondVersion === undefined) throw new Error('Photo version missing');
    expect(secondVersion).toBeGreaterThan(version);
    const removed = await send('DELETE');
    expect(agentSchema.parse(removed.json()).avatar_version).toBeUndefined();
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await send('GET')).statusCode).toBe(404);
    vi.spyOn(Date, 'now').mockReturnValue(version);
    const readded = await send('PUT', undefined, jpeg, undefined, { 'content-type': 'image/jpeg' });
    expect(agentSchema.parse(readded.json()).avatar_version).toBeGreaterThan(secondVersion);
  });

  it('validates bytes, size, authentication and ownership', async () => {
    const { send, path } = await setup();
    expect(
      (
        await send('PUT', undefined, Buffer.from('no'), undefined, { 'content-type': 'image/jpeg' })
      ).json(),
    ).toMatchObject({ error: { code: 'invalid_request' } });
    expect(
      (
        await send('PUT', undefined, Buffer.concat([jpeg, Buffer.alloc(300 * 1024)]), undefined, {
          'content-type': 'image/jpeg',
        })
      ).statusCode,
    ).toBe(413);
    expect(
      (await send('PUT', undefined, jpeg, undefined, { 'content-type': 'text/plain' })).statusCode,
    ).toBe(400);
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const body = method === 'PUT' ? jpeg : undefined;
      const headers: Record<string, string> =
        method === 'PUT' ? { 'content-type': 'image/jpeg' } : {};
      expect((await send(method, path, body, '', headers)).statusCode).toBe(401);
      expect((await send(method, path, body, 'Bearer other', headers)).statusCode).toBe(404);
      expect(
        (
          await send(
            method,
            '/v1/agents/agt_bbbbbbbbbbbbbbbbbbbb/avatar',
            body,
            'Bearer alice',
            headers,
          )
        ).statusCode,
      ).toBe(404);
    }
  });

  it('removes photos with the agent and with all user data', async () => {
    const { send, file } = await setup();
    await send('PUT', undefined, jpeg, undefined, { 'content-type': 'image/jpeg' });
    expect((await send('DELETE', `/v1/agents/${id}`)).statusCode).toBe(204);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    const other = await setup();
    await other.send('PUT', undefined, jpeg, undefined, { 'content-type': 'image/jpeg' });
    expect((await other.send('DELETE', '/v1/me/data')).statusCode).toBe(200);
    await expect(stat(other.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
