import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { loadGatewayEnv } from '@twring/config/gateway';
import {
  base64urlDecode,
  base64urlEncode,
  deriveSealKey,
  deviceTicketResponseSchema,
  RELAY_TICKET_AUDIENCE,
  generateSealKeyPair,
  pairResponseSchema,
  type PairResponse,
  verifyServerProof,
} from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { importJWK, jwtVerify } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { createRequestAuth, SELFHOST_PUBLIC_ROUTES } from '../auth';
import { CredentialCipher } from '../store/cipher';
import { MemoryCollection } from '../store/collection';
import { createMemoryStores } from '../store/repositories';

import { REMOVED_PHONE_MESSAGE, pairingAuthenticator } from './auth';
import { serverIdentityFromKey } from './identity';
import { createSelfhostMemoryStores, deviceSealAad, type SelfhostStores } from './people';
import { PersonRemover } from './removal';
import { cachedRingService, type RelayFetch, RelayClient } from './relay-client';
import { PAIR_CODE_FAILED, placeholderRingService, type RingServiceProvider } from './routes';

const keys = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 9).toString('base64')]]) };
const cipher = new CredentialCipher(keys);
const identity = serverIdentityFromKey(generateKeyPairSync('ed25519').privateKey);

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

async function server(
  options: {
    pairPerMinutePerIp?: number;
    pairPerHour?: number;
    ringService?: RingServiceProvider;
    waitlist?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'twring-selfhost-'));
  const stores: SelfhostStores = createSelfhostMemoryStores(cipher);
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString('utf8'));
      done();
    },
  });
  const auth = createRequestAuth(pairingAuthenticator(stores.devices), SELFHOST_PUBLIC_ROUTES);
  const app = buildApp({
    env: loadGatewayEnv(gatewayEnvFixture({ CORD_DATA_DIR: dir })),
    logger: { level: 'info', stream },
    auth,
    agents: {
      stores: createMemoryStores(keys),
      policy: { env: 'development', lookup: () => Promise.resolve([]) },
      writeRatePerMinute: 100,
    },
    me: { deleteRatePerMinute: 100 },
    ...(options.waitlist === true && {
      waitlist: { records: new MemoryCollection(), allowedOrigins: ['https://twring.com'] },
    }),
    selfhost: {
      stores,
      remover: new PersonRemover(stores),
      identity,
      serverName: 'home.example.com',
      audio: 'own',
      spaceId: 'default',
      ringService: options.ringService ?? placeholderRingService,
      relayUrl: 'https://relay.example.test',
      ...(options.pairPerHour !== undefined && { pairPerHour: options.pairPerHour }),
      ...(options.pairPerMinutePerIp !== undefined && {
        pairPerMinutePerIp: options.pairPerMinutePerIp,
      }),
    },
    onError: () => undefined,
  });
  // A /v1 route that answers only for a signed-in phone, like every app route.
  app.get('/v1/whoami', (request) => ({ user: auth.userFor(request) }));
  cleanup.push(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const phoneKeys = generateSealKeyPair();
  const pair = (code: string, name = 'Asha') =>
    app.inject({
      method: 'POST',
      url: '/v1/pair',
      payload: {
        code,
        display_name: name,
        device_name: 'Pixel 8',
        platform: 'android',
        seal_public_key: base64urlEncode(phoneKeys.publicKey),
      },
    });
  const paired = async (role: 'admin' | 'member', name?: string) => {
    const { code } = await stores.codes.mint(role, 'default');
    const response = await pair(code, name);
    expect(response.statusCode).toBe(201);
    return response.json<PairResponse>();
  };
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  return { app, stores, pair, paired, as, lines, phoneKeys };
}

describe('GET /v1/server', () => {
  it('is public and names the server', async () => {
    const { app } = await server();
    const response = await app.inject({ method: 'GET', url: '/v1/server' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      server_id: identity.id,
      mode: 'selfhost',
      audio: 'own',
      ring_service: { state: 'active' },
    });
  });
});

describe('GET /v1/server?nonce= (identity proof)', () => {
  const NONCE = 'AbCdEfGhIjKlMnOpQrStUv';

  it('answers the public key and a proof the app can verify', async () => {
    const { app } = await server();
    const response = await app.inject({ method: 'GET', url: `/v1/server?nonce=${NONCE}` });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ server_id: string; public_key: string; proof: string }>();
    expect(body.public_key).toBe(base64urlEncode(identity.publicKeyRaw));
    expect(
      verifyServerProof(body, { nonce: NONCE, nowMs: Date.now(), serverId: identity.id }),
    ).toEqual({ ok: true });
    expect(
      verifyServerProof(body, {
        nonce: 'ZZZZZZZZZZZZZZZZZZZZZZ',
        nowMs: Date.now(),
        serverId: identity.id,
      }),
    ).toEqual({
      ok: false,
      reason: 'claims_mismatch',
    });
  });

  it('without a nonce answers as before (no proof); a bad nonce is 400', async () => {
    const { app } = await server();
    const plain = (await app.inject({ method: 'GET', url: '/v1/server' })).json<object>();
    expect(plain).not.toHaveProperty('proof');
    expect(plain).not.toHaveProperty('public_key');
    expect((await app.inject({ method: 'GET', url: '/v1/server?nonce=short' })).statusCode).toBe(
      400,
    );
  });
});

describe('waitlist on a self-hosted server', () => {
  it('POST /v1/waitlist answers 404', async () => {
    const { app } = await server({ waitlist: true });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/waitlist',
      payload: { email: 'a@example.com', source: 'beta' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /v1/pair', () => {
  it('an admin code pairs an admin, a member code a member; token starts twd_', async () => {
    const { paired } = await server();
    const admin = await paired('admin');
    expect(pairResponseSchema.safeParse(admin).success).toBe(true);
    expect(admin.person.role).toBe('admin');
    expect(admin.device.token.startsWith('twd_')).toBe(true);
    expect((await paired('member', 'Ravi')).person.role).toBe('member');
  });

  it('two simultaneous pairs with one code: exactly one 201, the other the code copy', async () => {
    const { stores, pair } = await server();
    const { code } = await stores.codes.mint('member', 'default');
    const responses = await Promise.all([pair(code), pair(code)]);
    const statuses = responses.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, 400]);
    const refused = responses.find((r) => r.statusCode === 400)!;
    expect(refused.json<{ error: { message: string } }>().error.message).toBe(PAIR_CODE_FAILED);
  });

  it('a wrong or malformed code gets the one code copy', async () => {
    const { pair } = await server();
    for (const code of ['ABCD-EFGH', 'nope']) {
      const response = await pair(code);
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { message: string } }>().error.message).toBe(PAIR_CODE_FAILED);
    }
  });

  it('the sixth wrong code in a minute from one address is 429', async () => {
    const { pair } = await server();
    for (let i = 0; i < 5; i += 1) expect((await pair('ABCD-EFGH')).statusCode).toBe(400);
    expect((await pair('ABCD-EFGH')).statusCode).toBe(429);
  });

  it('the 6001st well-formed wrong code in an hour from different addresses is 429', async () => {
    const { app, phoneKeys } = await server();
    const attempt = (i: number) =>
      app.inject({
        method: 'POST',
        url: '/v1/pair',
        remoteAddress: `10.${Math.floor(i / 250)}.${i % 250}.1`,
        payload: {
          code: 'ABCD-EFGH',
          display_name: 'Asha',
          device_name: 'Pixel 8',
          platform: 'android',
          seal_public_key: base64urlEncode(phoneKeys.publicKey),
        },
      });
    for (let i = 1; i <= 6000; i += 1) expect((await attempt(i)).statusCode).toBe(400);
    expect((await attempt(6001)).statusCode).toBe(429);
  });

  it('malformed requests count only per address, never against the server budget', async () => {
    const { app, paired } = await server({ pairPerHour: 5 });
    for (let i = 1; i <= 50; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/pair',
        remoteAddress: `10.${Math.floor(i / 250)}.${i % 250}.2`,
        payload: { code: 'nope' },
      });
      expect(response.statusCode).toBe(400);
    }
    // A real code still pairs.
    expect((await paired('member')).person.role).toBe('member');
  });

  it('IPv6 addresses in one /64 share the per-address limit', async () => {
    const { app } = await server();
    const attempt = (host: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/pair',
        remoteAddress: `2001:db8:1:2::${host}`,
        payload: { code: 'ABCD-EFGH' },
      });
    for (let i = 1; i <= 5; i += 1) expect((await attempt(String(i))).statusCode).toBe(400);
    expect((await attempt('99')).statusCode).toBe(429);
  });

  it('returns the server seal key; the private half is stored sealed; both sides derive one key', async () => {
    const { paired, stores, phoneKeys } = await server();
    const response = await paired('admin');
    const device = (await stores.devices.get(response.device.id))!;
    expect(JSON.stringify(device)).not.toContain(base64urlEncode(phoneKeys.privateKey));
    const serverPrivate = base64urlDecode(
      cipher.open(device.server_seal_private_key, deviceSealAad(device.id)),
    );
    const phoneSide = deriveSealKey(
      phoneKeys.privateKey,
      base64urlDecode(response.seal_server_public_key),
    );
    const serverSide = deriveSealKey(serverPrivate, phoneKeys.publicKey);
    expect(Buffer.from(phoneSide).equals(Buffer.from(serverSide))).toBe(true);
    expect(JSON.stringify(device)).not.toContain(base64urlEncode(serverPrivate));
  });

  it('logs during pairing contain neither the code nor the token', async () => {
    const { stores, pair, lines } = await server();
    const { code } = await stores.codes.mint('admin', 'default');
    const response = await pair(code);
    const token = response.json<PairResponse>().device.token;
    await pair(code);
    const log = lines.join('');
    expect(log).toContain('phone_paired');
    expect(log).not.toContain(code);
    expect(log).not.toContain(code.replace('-', ''));
    expect(log).not.toContain(token);
  });
});

describe('pairing auth', () => {
  it('a valid token resolves the person; unknown token 401', async () => {
    const { app, paired, as } = await server();
    const admin = await paired('admin');
    const ok = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: as(admin.device.token),
    });
    expect(ok.json()).toEqual({ user: admin.person.id });
    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: as('twd_unknownunknownunknown'),
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toMatchObject({ error: { code: 'device_removed' } });
    const none = await app.inject({ method: 'GET', url: '/v1/whoami' });
    expect(none.statusCode).toBe(401);
  });

  it('a removed phone answers 401 device_removed with the removed copy', async () => {
    const { app, paired, as } = await server();
    const admin = await paired('admin');
    const member = await paired('member', 'Ravi');
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/people/${member.person.id}/devices/${member.device.id}`,
      headers: as(admin.device.token),
    });
    expect(removed.statusCode).toBe(204);
    const next = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: as(member.device.token),
    });
    expect(next.statusCode).toBe(401);
    expect(next.json()).toMatchObject({
      error: { code: 'device_removed', message: REMOVED_PHONE_MESSAGE },
    });
  });

  it('a removed person answers 401 with the same copy', async () => {
    const { app, paired, as } = await server();
    const admin = await paired('admin');
    const member = await paired('member', 'Ravi');
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/people/${member.person.id}`,
      headers: as(admin.device.token),
    });
    expect(removed.statusCode).toBe(204);
    const next = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: as(member.device.token),
    });
    expect(next.statusCode).toBe(401);
    expect(next.json<{ error: { message: string } }>().error.message).toBe(REMOVED_PHONE_MESSAGE);
    expect(next.json()).toMatchObject({ error: { code: 'device_removed' } });
  });
});

describe('people and phones', () => {
  it('removing the last admin is refused with 409', async () => {
    const { app, paired, as } = await server();
    const admin = await paired('admin');
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/people/${admin.person.id}`,
      headers: as(admin.device.token),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'last_admin' } });
  });

  it('a member cannot mint codes (403); an admin can', async () => {
    const { app, paired, as } = await server();
    const admin = await paired('admin');
    const member = await paired('member', 'Ravi');
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/people/codes',
      headers: as(member.device.token),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'forbidden' } });
    const minted = await app.inject({
      method: 'POST',
      url: '/v1/people/codes',
      headers: as(admin.device.token),
    });
    expect(minted.statusCode).toBe(201);
    expect(minted.json<{ code: string }>().code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('a person removes their own phone but not someone else’s; an admin removes any', async () => {
    const { app, paired, as } = await server();
    const admin = await paired('admin');
    const ravi = await paired('member', 'Ravi');
    const mira = await paired('member', 'Mira');
    const other = await app.inject({
      method: 'DELETE',
      url: `/v1/me/paired-devices/${mira.device.id}`,
      headers: as(ravi.device.token),
    });
    expect(other.statusCode).toBe(404);
    const own = await app.inject({
      method: 'DELETE',
      url: `/v1/me/paired-devices/${ravi.device.id}`,
      headers: as(ravi.device.token),
    });
    expect(own.statusCode).toBe(204);
    const byAdmin = await app.inject({
      method: 'DELETE',
      url: `/v1/me/paired-devices/${mira.device.id}`,
      headers: as(admin.device.token),
    });
    expect(byAdmin.statusCode).toBe(204);
  });

  it('an admin lists everyone with phones; a member sees only themselves', async () => {
    const { app, paired, as } = await server();
    const admin = await paired('admin');
    const member = await paired('member', 'Ravi');
    const all = await app.inject({
      method: 'GET',
      url: '/v1/people',
      headers: as(admin.device.token),
    });
    expect(all.json<{ people: unknown[] }>().people).toHaveLength(2);
    const mine = await app.inject({
      method: 'GET',
      url: '/v1/people',
      headers: as(member.device.token),
    });
    const list = mine.json<{ people: { id: string; devices: unknown[] }[] }>().people;
    expect(list.map((p) => p.id)).toEqual([member.person.id]);
    expect(list[0]!.devices).toHaveLength(1);
  });

  it('Delete my data removes the person and their phones', async () => {
    const { app, paired, as, stores } = await server();
    await paired('admin');
    const member = await paired('member', 'Ravi');
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/me/data',
      headers: as(member.device.token),
    });
    expect(response.statusCode).toBe(200);
    expect(await stores.people.get(member.person.id)).toBeUndefined();
    expect(await stores.devices.get(member.device.id)).toBeUndefined();
    const next = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: as(member.device.token),
    });
    expect(next.statusCode).toBe(401);
  });
});

describe('ring relay', () => {
  const verifyTicket = async (ticket: string) => {
    const key = await importJWK(
      { kty: 'OKP', crv: 'Ed25519', x: base64urlEncode(identity.publicKeyRaw) },
      'EdDSA',
    );
    return (
      await jwtVerify(ticket, key, {
        algorithms: ['EdDSA'],
        audience: RELAY_TICKET_AUDIENCE,
        issuer: identity.id,
      })
    ).payload;
  };

  it('a ticket names the calling phone only, and is not logged', async () => {
    const { app, paired, as, stores, lines } = await server();
    const admin = await paired('admin');
    const member = await paired('member', 'Ravi');
    // The admin's own second phone too, so "the person's phone" is not enough.
    const { device: second, token: secondToken } = await stores.devices.create({
      personId: admin.person.id,
      name: 'Tablet',
      platform: 'android',
      sealPublicKey: base64urlEncode(new Uint8Array(32).fill(1)),
    });
    for (const [token, deviceId] of [
      [admin.device.token, admin.device.id],
      [member.device.token, member.device.id],
      [secondToken, second.id],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/me/paired-devices/current/ticket',
        headers: as(token),
      });
      expect(response.statusCode).toBe(200);
      const body = deviceTicketResponseSchema.parse(response.json());
      expect(body.relay_url).toBe('https://relay.example.test');
      expect((await verifyTicket(body.ticket)).sub).toBe(deviceId);
      expect(lines.join('')).not.toContain(body.ticket);
    }
  });

  it('a ticket needs a paired phone', async () => {
    const { app, paired, as, stores } = await server();
    const admin = await paired('admin');
    await stores.devices.remove(admin.device.id);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/me/paired-devices/current/ticket',
      headers: as(admin.device.token),
    });
    expect(response.statusCode).toBe(401);
  });

  it('the relay handle is saved to the calling phone, never logged', async () => {
    const { app, paired, as, stores, lines } = await server();
    const admin = await paired('admin');
    const member = await paired('member', 'Ravi');
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/me/paired-devices/current/relay',
      headers: as(member.device.token),
      payload: { handle: 'hdl_secret_member' },
    });
    expect(response.statusCode).toBe(204);
    expect((await stores.devices.get(member.device.id))?.relay_handle).toBe('hdl_secret_member');
    expect((await stores.devices.get(admin.device.id))?.relay_handle).toBeUndefined();
    expect(lines.join('')).not.toContain('hdl_secret_member');
    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/me/paired-devices/current/relay',
      headers: as(member.device.token),
      payload: { handle: '' },
    });
    expect(bad.statusCode).toBe(400);
    const taken = await app.inject({
      method: 'PUT',
      url: '/v1/me/paired-devices/current/relay',
      headers: as(admin.device.token),
      payload: { handle: 'hdl_secret_member' },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json<{ error: { code: string } }>().error.code).toBe('relay_handle_taken');
    expect((await stores.devices.get(admin.device.id))?.relay_handle).toBeUndefined();
  });

  it('the phone can clear its own relay handle, which the relay is told', async () => {
    const { app, paired, as, stores } = await server();
    const member = await paired('member', 'Ravi');
    const other = await paired('member', 'Meera');
    await stores.devices.setRelayHandle(member.device.id, 'hdl_member');
    await stores.devices.setRelayHandle(other.device.id, 'hdl_other');
    const dropped: string[] = [];
    stores.devices.onRelayHandlesDropped((handles) => dropped.push(...handles));
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/me/paired-devices/current/relay',
      headers: as(member.device.token),
    });
    expect(response.statusCode).toBe(204);
    expect((await stores.devices.get(member.device.id))?.relay_handle).toBeUndefined();
    expect((await stores.devices.get(other.device.id))?.relay_handle).toBe('hdl_other');
    expect(dropped).toEqual(['hdl_member']);
    // Clearing again is fine: nothing left to drop.
    const again = await app.inject({
      method: 'DELETE',
      url: '/v1/me/paired-devices/current/relay',
      headers: as(member.device.token),
    });
    expect(again.statusCode).toBe(204);
    expect(dropped).toEqual(['hdl_member']);
  });

  it('clearing the handle of a removed phone answers 404, and is limited to 10 a minute', async () => {
    const { app, paired, as, stores } = await server();
    const admin = await paired('admin');
    const member = await paired('member', 'Ravi');
    const clear = () =>
      app.inject({
        method: 'DELETE',
        url: '/v1/me/paired-devices/current/relay',
        headers: as(member.device.token),
      });
    for (let i = 0; i < 10; i += 1) expect((await clear()).statusCode).toBe(204);
    expect((await clear()).statusCode).toBe(429);
    await stores.devices.remove(member.device.id);
    // A removed phone's token no longer authenticates at all.
    expect([401, 404]).toContain((await clear()).statusCode);
    expect(admin.device.id).not.toBe(member.device.id);
  });

  it('removing a phone clears its relay handle and tells the relay', async () => {
    const { app, paired, as, stores } = await server();
    const admin = await paired('admin');
    const member = await paired('member', 'Ravi');
    await stores.devices.setRelayHandle(member.device.id, 'hdl_member');
    const dropped: string[] = [];
    stores.devices.onRelayHandlesDropped((handles) => dropped.push(...handles));
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/people/${member.person.id}/devices/${member.device.id}`,
      headers: as(admin.device.token),
    });
    expect(response.statusCode).toBe(204);
    expect((await stores.devices.get(member.device.id))?.relay_handle).toBeUndefined();
    expect(dropped).toEqual(['hdl_member']);
  });

  it('removing a person clears every handle of theirs', async () => {
    const { app, paired, as, stores } = await server();
    const admin = await paired('admin');
    const member = await paired('member', 'Ravi');
    await stores.devices.setRelayHandle(member.device.id, 'hdl_member');
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/people/${member.person.id}`,
      headers: as(admin.device.token),
    });
    expect(response.statusCode).toBe(204);
    expect((await stores.devices.get(member.device.id))?.relay_handle).toBeUndefined();
  });

  it.each(['unverified', 'paused', 'expired'])(
    '/v1/server shows %s from the relay, and keeps it when the relay times out',
    async (state) => {
      let up = true;
      const fetch: RelayFetch = (_url, init) =>
        up
          ? Promise.resolve(
              new Response(
                JSON.stringify({ state, paid_until: '2027-01-01T00:00:00.000Z', verified: false }),
                { status: 200 },
              ),
            )
          : new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
      let now = 0;
      const ring = cachedRingService(
        new RelayClient({
          baseUrl: 'https://relay.example.test',
          relayKey: () => Promise.resolve('twr_x'),
          fetch,
          timeoutMs: 20,
        }),
        { now: () => now },
      );
      const { app } = await server({ ringService: ring.provider });
      const get = async () =>
        (await app.inject({ method: 'GET', url: '/v1/server' })).json<{
          ring_service: unknown;
        }>().ring_service;
      expect(await get()).toEqual({ state, paid_until: '2027-01-01T00:00:00.000Z' });
      up = false;
      now = 11 * 60_000;
      expect(await get()).toEqual({ state, paid_until: '2027-01-01T00:00:00.000Z' });
    },
  );
});

describe('hosted mode', () => {
  it('/v1/server and /v1/pair answer 404', async () => {
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      auth: createRequestAuth(() => Promise.resolve('dev-user')),
      onError: () => undefined,
    });
    cleanup.push(() => app.close());
    expect((await app.inject({ method: 'GET', url: '/v1/server' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/pair', payload: { code: 'ABCD-EFGH' } }))
        .statusCode,
    ).toBe(404);
    for (const [method, url] of [
      ['POST', '/v1/me/paired-devices/current/ticket'],
      ['PUT', '/v1/me/paired-devices/current/relay'],
      ['DELETE', '/v1/me/paired-devices/current/relay'],
    ] as const) {
      expect((await app.inject({ method, url, payload: { handle: 'h' } })).statusCode).toBe(404);
    }
  });
});
