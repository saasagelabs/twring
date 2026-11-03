import {
  errorResponseSchema,
  pairingResponseSchema,
  pairingStatusResponseSchema,
  relinkResponseSchema,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { PairingBook, PAIRING_TTL_MS } from './pairing';
import { FAKE_AGENTS } from './testing';

/** ADR-027 re-link: a computer that is already linked claims a new code with its own token. */

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway(options: Parameters<typeof startConnectorGateway>[0] = {}) {
  const g = await startConnectorGateway(options);
  gateways.push(g);
  return g;
}

async function newPairing(g: ConnectorGateway, user: string) {
  return pairingResponseSchema.parse(
    (await g.send('POST', '/v1/connectors/pairings', { user })).json(),
  );
}

const relink = (g: ConnectorGateway, code: string, token: string, name = 'Hermes VPS') =>
  g.send('POST', '/v1/connectors/claim', {
    headers: { authorization: `Bearer ${token}` },
    body: { code, name, agents: [FAKE_AGENTS[0]!] },
  });

describe('claim with an existing connector token', () => {
  it('joins the same user’s pairing to that connector: no new row, no new token', async () => {
    const g = await gateway();
    const { connectorId, token } = await g.pair('alice');
    const pairing = await newPairing(g, 'alice');
    const res = await relink(g, pairing.code, token);
    expect(res.statusCode).toBe(200);
    const body = relinkResponseSchema.parse(res.json());
    expect(body).toEqual({ connector_id: connectorId, reused: true });
    expect(res.json()).not.toHaveProperty('token');

    const rows = await g.stores.connectors.list('alice');
    expect(rows.map((r) => r.id)).toEqual([connectorId]);
    expect(rows[0]?.name).toBe('Hermes VPS');
    expect(rows[0]?.agents.map((a) => a.id)).toEqual([FAKE_AGENTS[0]!.id]);

    const status = pairingStatusResponseSchema.parse(
      (
        await g.send('GET', `/v1/connectors/pairings/${pairing.pairing_id}`, { user: 'alice' })
      ).json(),
    );
    expect(status.status).toBe('claimed');
    expect(status.connector).toMatchObject({ id: connectorId, name: 'Hermes VPS' });

    // The code is spent.
    const again = await relink(g, pairing.code, token);
    expect(errorResponseSchema.parse(again.json()).error.code).toBe('pairing_invalid');
    expect(again.statusCode).toBe(400);
  });

  it('refuses another account’s code with 403 and leaves the code usable', async () => {
    const g = await gateway();
    const { token } = await g.pair('alice');
    const pairing = await newPairing(g, 'bob');
    const res = await relink(g, pairing.code, token);
    expect(res.statusCode).toBe(403);
    const error = errorResponseSchema.parse(res.json()).error;
    expect(error.code).toBe('pairing_other_account');
    expect(error.message).toBe('This machine is linked to another Twring account.');
    expect(await g.stores.connectors.list('bob')).toEqual([]);
    // After `uninstall --forget` the same code still pairs, fresh.
    const fresh = await g.send('POST', '/v1/connectors/claim', {
      body: { code: pairing.code, name: 'Laptop', agents: FAKE_AGENTS },
    });
    expect(fresh.statusCode).toBe(201);
    expect(await g.stores.connectors.list('bob')).toHaveLength(1);
  });

  it('refuses a revoked or unknown token with 401 and does not spend the code', async () => {
    const g = await gateway();
    const { connectorId, token } = await g.pair('alice');
    expect(
      (await g.send('DELETE', `/v1/connectors/${connectorId}`, { user: 'alice' })).statusCode,
    ).toBe(204);
    const pairing = await newPairing(g, 'alice');
    const res = await relink(g, pairing.code, token);
    expect(res.statusCode).toBe(401);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('connector_invalid');
    const malformed = await g.send('POST', '/v1/connectors/claim', {
      headers: { authorization: 'Bearer nope' },
      body: { code: pairing.code, name: 'Laptop', agents: FAKE_AGENTS },
    });
    expect(malformed.statusCode).toBe(401);
    expect(await g.stores.connectors.list('alice')).toEqual([]);
    const status = pairingStatusResponseSchema.parse(
      (
        await g.send('GET', `/v1/connectors/pairings/${pairing.pairing_id}`, { user: 'alice' })
      ).json(),
    );
    expect(status.status).toBe('pending');
  });

  it('refuses a wrong or expired code with 400', async () => {
    let now = 1_000_000;
    const g = await gateway({ pairings: new PairingBook(() => now) });
    const { token } = await g.pair('alice');
    expect((await relink(g, 'ZZZZ-ZZZZ', token)).statusCode).toBe(400);
    const pairing = await newPairing(g, 'alice');
    now += PAIRING_TTL_MS + 1;
    const res = await relink(g, pairing.code, token);
    expect(res.statusCode).toBe(400);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('pairing_invalid');
    expect(await g.stores.connectors.list('alice')).toHaveLength(1);
  });
});
