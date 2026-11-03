import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadGatewayEnv } from '@twring/config/gateway';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import { createRequestAuth } from '../auth';
import { MemoryCollection } from '../store/collection';
import type { WaitlistRecord } from '../waitlist/routes';
import { hashCode, type InviteCodeRecord, type RedemptionRecord } from './invites';

async function fixture(extraEnv: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cord-invite-routes-'));
  const membersFile = join(dir, 'beta-members.json');
  const codesFile = join(dir, 'invite-codes.json');
  await writeFile(membersFile, JSON.stringify({ emails: ['member@example.com'] }));
  await writeFile(
    codesFile,
    JSON.stringify({
      codes: [
        {
          hash: hashCode('123456'),
          uses: 1,
          expires_at: '2099-01-01T00:00:00.000Z',
          note: '',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
  );
  const records = new MemoryCollection<WaitlistRecord>();
  const redemptions = new MemoryCollection<RedemptionRecord>();
  const onNewSignup = vi.fn(() => Promise.resolve());
  const env = loadGatewayEnv(
    gatewayEnvFixture({ BETA_MEMBERS_FILE: membersFile, CORD_DATA_DIR: dir, ...extraEnv }),
  );
  const auth = createRequestAuth((request) =>
    Promise.resolve({
      id: String(request.headers['x-user-id'] ?? 'user'),
      email: String(request.headers['x-test-email'] ?? 'outsider@example.com'),
    }),
  );
  const app = buildApp({
    env,
    auth,
    onError: () => undefined,
    invites: {
      codesFile,
      autoCodes: new MemoryCollection<InviteCodeRecord>(),
      redemptions,
    },
    waitlist: { records, allowedOrigins: [], onNewSignup },
  });
  app.get('/v1/agents', () => ({ ok: true }));
  app.delete('/v1/me/data', () => ({ ok: true }));
  app.delete('/v1/me/devices/:deviceId', () => ({ ok: true }));
  app.post('/v1/connectors/messages', () => ({ ok: true }));
  return {
    app,
    records,
    redemptions,
    onNewSignup,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('invite routes and gate', () => {
  it('leaves access routes unmounted when the gate is off', async () => {
    const env = loadGatewayEnv(gatewayEnvFixture());
    const auth = createRequestAuth(() => Promise.resolve({ id: 'user', email: 'a@example.com' }));
    const app = buildApp({ env, auth, onError: () => undefined });
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/me/access' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('reports access and joins a non-member to the waitlist only once', async () => {
    const { app, records, onNewSignup, close } = await fixture();
    try {
      const member = await app.inject({
        method: 'GET',
        url: '/v1/me/access',
        headers: { 'x-test-email': 'member@example.com' },
      });
      expect(member.json()).toMatchObject({ member: true, email: 'member@example.com' });
      for (let i = 0; i < 2; i += 1) {
        const response = await app.inject({ method: 'GET', url: '/v1/me/access' });
        expect(response.json()).toMatchObject({ member: false, email: 'outsider@example.com' });
      }
      expect(await records.read()).toMatchObject([
        { email: 'outsider@example.com', source: 'app' },
      ]);
      expect(onNewSignup).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it('with automatic places, a signed-in newcomer is let in at once and not put on the waitlist', async () => {
    const { app, records, redemptions, onNewSignup, close } = await fixture({
      AUTO_ADMIT_PER_DAY: '1',
    });
    try {
      const first = await app.inject({
        method: 'GET',
        url: '/v1/me/access',
        headers: { 'x-user-id': 'user-a', 'x-test-email': 'a@example.com' },
      });
      expect(first.json()).toMatchObject({ member: true, email: 'a@example.com' });
      expect(await redemptions.read()).toMatchObject([
        { email: 'a@example.com', user_id: 'user-a', auto: true },
      ]);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/agents',
            headers: { 'x-test-email': 'a@example.com' },
          })
        ).statusCode,
      ).toBe(200);
      // Today's one place is taken: the next newcomer waits on the list as before.
      const second = await app.inject({
        method: 'GET',
        url: '/v1/me/access',
        headers: { 'x-user-id': 'user-b', 'x-test-email': 'b@example.com' },
      });
      expect(second.json()).toMatchObject({ member: false });
      expect(await records.read()).toMatchObject([{ email: 'b@example.com', source: 'app' }]);
      expect(onNewSignup).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it('someone who waited and gets in later is no longer counted as waiting', async () => {
    const { app, records, close } = await fixture({ AUTO_ADMIT_PER_DAY: '1' });
    const at = (user: string, email: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/me/access',
        headers: { 'x-user-id': user, 'x-test-email': email },
      });
    try {
      await at('user-a', 'a@example.com');
      expect((await at('user-b', 'b@example.com')).json()).toMatchObject({ member: false });
      expect((await records.read())[0]).toMatchObject({ email: 'b@example.com' });
      expect((await records.read())[0]?.invited_at).toBeUndefined();
      vi.useFakeTimers({ now: Date.now() + 86_400_000, toFake: ['Date'] });
      expect((await at('user-b', 'b@example.com')).json()).toMatchObject({ member: true });
      expect((await records.read())[0]?.invited_at).toBeDefined();
    } finally {
      vi.useRealTimers();
      await close();
    }
  });

  it('stores the signed-in account with the redemption', async () => {
    const { app, redemptions, close } = await fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/me/invite',
        headers: { 'x-user-id': 'user-42' },
        payload: { code: '123456' },
      });
      expect(response.statusCode).toBe(200);
      expect(await redemptions.read()).toMatchObject([
        { email: 'outsider@example.com', user_id: 'user-42' },
      ]);
    } finally {
      await close();
    }
  });

  it('allows redemption through the gate, rejects bad codes, and limits attempts', async () => {
    const { app, close } = await fixture();
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/agents' })).json()).toMatchObject({
        error: { code: 'not_invited' },
      });
      expect((await app.inject({ method: 'DELETE', url: '/v1/me/data' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'DELETE', url: '/v1/me/devices/x' })).statusCode).toBe(
        200,
      );
      expect(
        (await app.inject({ method: 'POST', url: '/v1/connectors/messages' })).statusCode,
      ).toBe(200);
      const bad = await app.inject({
        method: 'POST',
        url: '/v1/me/invite',
        payload: { code: '999999' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: { code: 'invite_invalid' } });
      const good = await app.inject({
        method: 'POST',
        url: '/v1/me/invite',
        payload: { code: '123456' },
      });
      expect(good.statusCode).toBe(200);
      expect(good.json()).toMatchObject({ member: true, email: 'outsider@example.com' });
      expect((await app.inject({ method: 'GET', url: '/v1/agents' })).statusCode).toBe(200);
      for (let i = 0; i < 3; i += 1)
        await app.inject({ method: 'POST', url: '/v1/me/invite', payload: { code: 'bad' } });
      expect(
        (
          await app.inject({ method: 'POST', url: '/v1/me/invite', payload: { code: 'bad' } })
        ).json(),
      ).toMatchObject({ error: { code: 'rate_limited' } });
    } finally {
      await close();
    }
  });
});
