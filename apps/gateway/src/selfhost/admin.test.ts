import { generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { runAdminCli } from '../admin-cli';
import { PairingBook } from '../connectors/pairing';
import { CredentialCipher } from '../store/cipher';

import { adminTokenMatches, buildAdminServer, startAdminListener } from './admin';
import { serverIdentityFromKey } from './identity';
import { createSelfhostMemoryStores } from './people';
import { PersonRemover } from './removal';

const TOKEN = 'a'.repeat(40);
const keys = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 3).toString('base64')]]) };
const identity = serverIdentityFromKey(generateKeyPairSync('ed25519').privateKey);

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

function admin() {
  const stores = createSelfhostMemoryStores(new CredentialCipher(keys));
  const pairings = new PairingBook();
  const app = buildAdminServer({
    token: TOKEN,
    stores,
    remover: new PersonRemover(stores),
    identity,
    spaceId: 'default',
    pairings,
  });
  cleanup.push(() => app.close());
  const auth = { authorization: `Bearer ${TOKEN}` };
  return { app, stores, pairings, auth };
}

describe('admin listener', () => {
  it('a wrong or missing token is 401', async () => {
    const { app } = admin();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/admin/status',
          headers: { authorization: 'Bearer wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/status' })).statusCode).toBe(401);
    expect(adminTokenMatches(TOKEN, `Bearer ${TOKEN}`)).toBe(true);
    expect(adminTokenMatches(TOKEN, TOKEN)).toBe(false);
  });

  it('mints codes, lists people, refuses the last admin, reports status', async () => {
    const { app, stores, auth } = admin();
    const minted = await app.inject({
      method: 'POST',
      url: '/admin/codes',
      headers: auth,
      payload: { role: 'admin' },
    });
    expect(minted.statusCode).toBe(201);
    expect(await stores.codes.consume(minted.json<{ code: string }>().code)).toEqual({
      role: 'admin',
      spaceId: 'default',
    });
    const person = await stores.people.create({
      displayName: 'Asha',
      role: 'admin',
      spaceId: 'default',
    });
    const people = await app.inject({ method: 'GET', url: '/admin/people', headers: auth });
    expect(people.json<{ people: { id: string }[] }>().people.map((p) => p.id)).toEqual([
      person.id,
    ]);
    const refused = await app.inject({
      method: 'DELETE',
      url: `/admin/people/${person.id}`,
      headers: auth,
    });
    expect(refused.statusCode).toBe(409);
    const status = await app.inject({ method: 'GET', url: '/admin/status', headers: auth });
    expect(status.json()).toMatchObject({ server_id: identity.id, people: 1, admins: 1 });
  });

  it('status names the ring service as the server last heard it', async () => {
    const stores = createSelfhostMemoryStores(new CredentialCipher(keys));
    const app = buildAdminServer({
      token: TOKEN,
      stores,
      remover: new PersonRemover(stores),
      identity,
      spaceId: 'default',
      pairings: new PairingBook(),
      ringService: () =>
        Promise.resolve({ state: 'unverified', paid_until: '2027-06-30T00:00:00.000Z' }),
    });
    cleanup.push(() => app.close());
    const status = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(status.json()).toMatchObject({
      ring_service: { state: 'unverified', paid_until: '2027-06-30T00:00:00.000Z' },
    });
  });

  it('mints a connector code for a person with the connector pairing book', async () => {
    const { app, stores, pairings, auth } = admin();
    const person = await stores.people.create({
      displayName: 'Asha',
      role: 'admin',
      spaceId: 'default',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/admin/connector-code',
      headers: auth,
      payload: { person_id: person.id },
    });
    expect(response.statusCode).toBe(201);
    const { code } = response.json<{ code: string }>();
    expect(pairings.peek(code)?.userId).toBe(person.id);
    const unknown = await app.inject({
      method: 'POST',
      url: '/admin/connector-code',
      headers: auth,
      payload: { person_id: 'nobody' },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('listens on 127.0.0.1 only, and the CLI talks to it', async () => {
    const { app } = admin();
    const bound = await startAdminListener(app, 0);
    expect(bound.address).toBe('127.0.0.1');
    const out: string[] = [];
    const code = await runAdminCli(['status'], {
      token: TOKEN,
      port: bound.port,
      out: (text) => out.push(text),
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain(identity.id);
    expect(
      await runAdminCli(['status'], {
        token: 'b'.repeat(40),
        port: bound.port,
        out: () => undefined,
      }),
    ).toBe(1);
  });
});
