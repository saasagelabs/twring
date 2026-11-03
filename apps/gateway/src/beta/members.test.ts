import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { loadGatewayEnv } from '@twring/config/gateway';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { AuthError, createRequestAuth, type AuthenticatedUser } from '../auth';
import { createLoggerOptions } from '../logger';

import { createBetaMembers } from './members';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function membersFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cord-beta-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'members.json');
  await writeFile(path, contents);
  return path;
}

function testApp(path?: string) {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const env = loadGatewayEnv(
    gatewayEnvFixture({
      LOG_LEVEL: 'info',
      ...(path !== undefined && { BETA_MEMBERS_FILE: path }),
    }),
  );
  const auth = createRequestAuth((request) => {
    const email = request.headers['x-test-email'];
    const user: AuthenticatedUser = { id: 'test-user' };
    if (typeof email === 'string') user.email = email;
    return Promise.resolve(user);
  });
  const app = buildApp({
    env,
    auth,
    logger: { ...createLoggerOptions(env), stream: sink },
    onError: () => undefined,
  });
  app.get('/v1/agents', () => ({ ok: true }));
  app.post('/v1/calls', () => ({ ok: true }));
  app.post('/v1/link-requests/:code/approve', () => ({ ok: true }));
  app.delete('/v1/me/data', () => ({ ok: true }));
  app.delete('/v1/me/devices/:deviceId', () => ({ ok: true }));
  app.post('/v1/connectors/claim', () => ({ ok: true }));
  app.post('/v1/connectors/messages', () => ({ ok: true }));
  app.get('/v1/files/:fileId', () => ({ ok: true }));
  app.post('/v1/connectors/files', () => ({ ok: true }));
  cleanups.push(() => app.close());
  const send = (method: 'GET' | 'POST' | 'DELETE', url: string, email?: string) =>
    app.inject({ method, url, ...(email !== undefined && { headers: { 'x-test-email': email } }) });
  return { send, lines };
}

describe('beta member gate', () => {
  it('leaves authenticated routes unchanged when the file is unset', async () => {
    const { send } = testApp();
    expect((await send('GET', '/v1/agents', 'stranger@example.com')).statusCode).toBe(200);
  });

  it('allows a member with trimmed, case-insensitive email matching', async () => {
    const path = await membersFile('{"emails":["  Invited@Example.COM  "]}');
    const { send } = testApp(path);
    expect((await send('GET', '/v1/agents', ' invited@example.com ')).statusCode).toBe(200);
  });

  it('rejects non-members before agents, calls, and link approval', async () => {
    const path = await membersFile('{"emails":["member@example.com"]}');
    const { send } = testApp(path);
    for (const [method, url] of [
      ['GET', '/v1/agents'],
      ['POST', '/v1/calls'],
      ['POST', '/v1/link-requests/123456/approve'],
    ] as const) {
      const response = await send(method, url, 'outsider@example.com');
      expect(response.statusCode).toBe(403);
      const body: unknown = response.json();
      expect(body).toMatchObject({
        error: {
          code: 'not_invited',
          message: "This Google account isn't in the Twring beta yet.",
        },
      });
    }
  });

  it('allows data deletion and phone removal for a signed-in non-member', async () => {
    const path = await membersFile('{"emails":[]}');
    const { send } = testApp(path);
    expect((await send('DELETE', '/v1/me/data', 'outsider@example.com')).statusCode).toBe(200);
    expect(
      (await send('DELETE', '/v1/me/devices/phone-1', 'outsider@example.com')).statusCode,
    ).toBe(200);
  });

  it('rejects a signed-in user with no email', async () => {
    const path = await membersFile('{"emails":["member@example.com"]}');
    const { send } = testApp(path);
    expect((await send('GET', '/v1/agents')).statusCode).toBe(403);
  });

  it('preserves authentication failures before the beta gate', async () => {
    const path = await membersFile('{"emails":[]}');
    const env = loadGatewayEnv(gatewayEnvFixture({ BETA_MEMBERS_FILE: path }));
    const auth = createRequestAuth(() =>
      Promise.reject(new AuthError(401, 'auth_required', 'Sign in to use Twring.')),
    );
    const app = buildApp({ env, auth, onError: () => undefined });
    app.get('/v1/agents', () => ({ ok: true }));
    cleanups.push(() => app.close());
    const response = await app.inject({ method: 'GET', url: '/v1/agents' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'auth_required' } });
  });

  it('fails closed for missing or invalid files and logs unavailability once per change', async () => {
    const path = await membersFile('{"emails":["member@example.com"]}');
    await rm(path);
    const { send, lines } = testApp(path);
    expect((await send('GET', '/v1/agents', 'member@example.com')).statusCode).toBe(403);
    expect((await send('GET', '/v1/agents', 'member@example.com')).statusCode).toBe(403);
    expect(lines.join('').match(/beta_members_unavailable/g)).toHaveLength(1);
    await writeFile(path, '{"emails":[42]}');
    // A fresh app sees the invalid file immediately, independent of the five-second stat cache.
    const invalid = testApp(path);
    expect((await invalid.send('GET', '/v1/agents', 'member@example.com')).statusCode).toBe(403);
    expect(invalid.lines.join('').match(/beta_members_unavailable/g)).toHaveLength(1);
  });

  it('leaves connector-authenticated public routes outside the gate', async () => {
    const path = await membersFile('{"emails":[]}');
    const { send } = testApp(path);
    expect((await send('POST', '/v1/connectors/claim')).statusCode).toBe(200);
  });

  it('keeps signed file links and connector messages outside sign-in and the gate', async () => {
    // Signed links and connector-token routes carry no user session (uploads, PR #67).
    const path = await membersFile('{"emails":[]}');
    const { send } = testApp(path);
    expect((await send('GET', '/v1/files/file_123')).statusCode).toBe(200);
    expect((await send('GET', '/v1/files/file_123', 'outsider@example.com')).statusCode).toBe(200);
    expect((await send('POST', '/v1/connectors/messages')).statusCode).toBe(200);
    expect((await send('POST', '/v1/connectors/files')).statusCode).toBe(200);
  });

  it('never logs the email on denial', async () => {
    const path = await membersFile('{"emails":[]}');
    const { send, lines } = testApp(path);
    await send('GET', '/v1/agents', 'secret@example.com');
    expect(lines.join('')).toContain('beta_access_denied');
    expect(lines.join('')).not.toContain('secret@example.com');
  });
});

describe('beta member file refresh', () => {
  it('reloads on a changed mtime after five seconds', async () => {
    const path = await membersFile('{"emails":["first@example.com"]}');
    let clock = 0;
    const members = createBetaMembers(path, { now: () => clock });
    expect(await members.has('first@example.com')).toBe(true);
    await writeFile(path, '{"emails":["second@example.com"]}');
    await utimes(path, new Date(20_000), new Date(20_000));
    expect(await members.has('second@example.com')).toBe(false);
    clock = 5_000;
    expect(await members.has('second@example.com')).toBe(true);
    expect(await members.has('first@example.com')).toBe(false);
  });
});
