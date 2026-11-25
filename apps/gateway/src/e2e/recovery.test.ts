/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import {
  base64urlEncode,
  newRecoverySalt,
  recoveryCheck,
  recoveryKeyFrom,
  recoveryWords,
  sealBackup,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';

const FLAG_ON = { PRIVATE_CHATS_ENABLED: 'true', THREADS_ENABLED: 'true' };
const phoneId = (c: string) => `dev_${c.repeat(20)}`;
const key = (n: number) => Buffer.alloc(32, n).toString('base64url');

let gateway: ConnectorGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

async function start(env: Record<string, string> = FLAG_ON) {
  gateway = await startConnectorGateway({ env });
  return gateway;
}

function addPhone(g: ConnectorGateway, user: string, c = 'p', n = 2) {
  g.e2e.add(user, { id: phoneId(c), kind: 'phone', name: 'Pixel', public_key: key(n) });
}

/** A real backup, made with real words; the words stay in this test. */
function backup(deviceId = phoneId('p')) {
  const words = recoveryWords();
  const salt = newRecoverySalt();
  const k = recoveryKeyFrom(words, salt);
  return {
    device_id: deviceId,
    salt: base64urlEncode(salt),
    check: recoveryCheck(k),
    sealed: sealBackup(k, new Uint8Array(32).fill(5), { account: 'a', deviceId }),
  };
}

describe('recovery backup routes', () => {
  it('saves, returns and deletes the backup', async () => {
    const g = await start();
    addPhone(g, 'u1');
    const body = backup();
    const put = await g.send('PUT', '/v1/e2e/recovery', { user: 'u1', body });
    expect(put.statusCode).toBe(200);
    const got = await g.send('GET', '/v1/e2e/recovery', { user: 'u1' });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ ...body, device_removed: false });
    expect((await g.send('DELETE', '/v1/e2e/recovery', { user: 'u1' })).statusCode).toBe(204);
    const gone = await g.send('GET', '/v1/e2e/recovery', { user: 'u1' });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe('no_backup');
  });

  it('never returns a backup to another account', async () => {
    const g = await start();
    addPhone(g, 'u1');
    expect(
      (await g.send('PUT', '/v1/e2e/recovery', { user: 'u1', body: backup() })).statusCode,
    ).toBe(200);
    const other = await g.send('GET', '/v1/e2e/recovery', { user: 'u2' });
    expect(other.statusCode).toBe(404);
    expect(JSON.stringify(other.json())).not.toContain(phoneId('p'));
    // Nor accepts one for a phone of another account.
    expect(
      (await g.send('PUT', '/v1/e2e/recovery', { user: 'u2', body: backup() })).statusCode,
    ).toBe(404);
  });

  it('refuses a body with extra fields, a bad shape or one too large', async () => {
    const g = await start();
    addPhone(g, 'u1');
    const send = (body: unknown) => g.send('PUT', '/v1/e2e/recovery', { user: 'u1', body });
    expect((await send({ ...backup(), words: 'a b c' })).statusCode).toBe(400);
    expect((await send({ ...backup(), salt: 'short' })).statusCode).toBe(400);
    expect((await send({ ...backup(), sealed: 'A'.repeat(17_000) })).statusCode).toBe(413);
  });

  it('says when the backup device was removed', async () => {
    const g = await start();
    addPhone(g, 'u1');
    await g.send('PUT', '/v1/e2e/recovery', { user: 'u1', body: backup() });
    expect(g.e2e.revoke('u1', phoneId('p'))).toBe(true);
    const got = await g.send('GET', '/v1/e2e/recovery', { user: 'u1' });
    expect(got.json().device_removed).toBe(true);
    // A removed phone cannot save a new backup.
    expect(
      (await g.send('PUT', '/v1/e2e/recovery', { user: 'u1', body: backup() })).statusCode,
    ).toBe(404);
  });

  it('limits backup reads per account', async () => {
    const g = await start();
    addPhone(g, 'u1');
    await g.send('PUT', '/v1/e2e/recovery', { user: 'u1', body: backup() });
    for (let i = 0; i < 10; i++)
      expect((await g.send('GET', '/v1/e2e/recovery', { user: 'u1' })).statusCode).toBe(200);
    const limited = await g.send('GET', '/v1/e2e/recovery', { user: 'u1' });
    expect(limited.statusCode).toBe(429);
    // Another account is not held back.
    expect((await g.send('GET', '/v1/e2e/recovery', { user: 'u2' })).statusCode).toBe(404);
  });

  it('answers 404 with the flag off, as the other private chat routes', async () => {
    const g = await start({});
    expect((await g.send('GET', '/v1/e2e/recovery', { user: 'u1' })).statusCode).toBe(404);
    expect(
      (await g.send('PUT', '/v1/e2e/recovery', { user: 'u1', body: backup() })).statusCode,
    ).toBe(404);
    expect((await g.send('DELETE', '/v1/e2e/recovery', { user: 'u1' })).statusCode).toBe(404);
  });

  it('a second phone of the account replaces the first one backup (one per account)', async () => {
    const g = await start();
    addPhone(g, 'u1');
    addPhone(g, 'u1', 'q', 3);
    await g.send('PUT', '/v1/e2e/recovery', { user: 'u1', body: backup() });
    const second = backup(phoneId('q'));
    expect((await g.send('PUT', '/v1/e2e/recovery', { user: 'u1', body: second })).statusCode).toBe(
      200,
    );
    const got = await g.send('GET', '/v1/e2e/recovery', { user: 'u1' });
    expect(got.json()).toMatchObject({ ...second, device_removed: false });
  });

  it('DELETE with no backup still answers 204', async () => {
    const g = await start();
    addPhone(g, 'u1');
    expect((await g.send('DELETE', '/v1/e2e/recovery', { user: 'u1' })).statusCode).toBe(204);
  });

  it('delete my data removes the backup', async () => {
    const g = await start();
    addPhone(g, 'u1');
    addPhone(g, 'u2', 'q', 3);
    await g.send('PUT', '/v1/e2e/recovery', { user: 'u1', body: backup() });
    await g.send('PUT', '/v1/e2e/recovery', { user: 'u2', body: backup(phoneId('q')) });
    expect((await g.send('DELETE', '/v1/me/data', { user: 'u1' })).statusCode).toBe(200);
    expect(g.e2e.recovery('u1')).toBeUndefined();
    expect(g.e2e.recovery('u2')).toBeDefined();
  });
});
