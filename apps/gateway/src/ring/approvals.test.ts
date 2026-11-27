import { connectorApprovalSchema, errorResponseSchema } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});
async function gateway() {
  const g = await startConnectorGateway({ ring: { push: false }, threads: {} });
  gateways.push(g);
  return g;
}
async function setupAgent(g: ConnectorGateway, user = 'alice') {
  const paired = await g.pair(user);
  const agentId = await g.createAgent(user, paired.connectorId);
  return { ...paired, agentId };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const code = (res: { json(): unknown }) => errorResponseSchema.parse(res.json()).error.code;
const body = (requestId = 'req-1', extra: Record<string, unknown> = {}) => ({
  local_agent: 'claude-code',
  request_id: requestId,
  title: 'Run a command',
  description: 'rm -rf build',
  origin_label: 'from the terminal',
  expires_in_s: 120,
  ...extra,
});
const create = (g: ConnectorGateway, token: string, b = body(), key = b.request_id) =>
  g.send('POST', '/v1/connectors/approvals', {
    headers: { ...bearer(token), 'idempotency-key': key },
    body: b,
  });

describe('connector approvals', () => {
  it('creates once, repeats with 200, and the phone decides without a relay', async () => {
    const g = await gateway();
    const { token, agentId } = await setupAgent(g);
    const first = await create(g, token);
    expect(first.statusCode).toBe(201);
    const approval = connectorApprovalSchema.parse(first.json());
    expect(approval.status).toBe('pending');
    const again = await create(g, token);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());

    const poll = g.send('GET', `/v1/connectors/approvals/${approval.approval_id}?wait=5`, {
      headers: bearer(token),
    });
    const decided = await g.send(
      'POST',
      `/v1/agents/${agentId}/approvals/${approval.approval_id}`,
      {
        user: 'alice',
        body: { decision: 'approve' },
      },
    );
    expect(decided.statusCode).toBe(200);
    expect((await poll).json()).toMatchObject({ status: 'allowed' });

    const late = await g.send('POST', `/v1/agents/${agentId}/approvals/${approval.approval_id}`, {
      user: 'alice',
      body: { decision: 'deny' },
    });
    expect(late.statusCode).toBe(409);
    expect(code(late)).toBe('approval_already_decided');
  });

  it('refuses a missing or different Idempotency-Key and a bad body', async () => {
    const g = await gateway();
    const { token } = await setupAgent(g);
    expect((await create(g, token, body(), 'other')).statusCode).toBe(400);
    const noKey = await g.send('POST', '/v1/connectors/approvals', {
      headers: bearer(token),
      body: body(),
    });
    expect(noKey.statusCode).toBe(400);
    expect((await create(g, token, body('req-2', { expires_in_s: 5 }))).statusCode).toBe(400);
  });

  it('refuses an unsaved agent, a private chat and a fourth pending approval', async () => {
    const g = await gateway();
    const { token, agentId } = await setupAgent(g);
    const unsaved = await create(g, token, body('req-x', { local_agent: 'codex' }));
    expect([unsaved.statusCode, code(unsaved)]).toEqual([404, 'agent_not_saved']);
    for (const id of ['r1', 'r2', 'r3'])
      expect((await create(g, token, body(id))).statusCode).toBe(201);
    const full = await create(g, token, body('r4'));
    expect([full.statusCode, code(full)]).toEqual([409, 'approvals_full']);
    await g.threads!.store.setPrivate('alice', agentId);
    const sealed = await create(g, token, body('r5'));
    expect([sealed.statusCode, code(sealed)]).toEqual([409, 'approval_private_chat']);
  });

  it('DELETE expires it, and another account or computer gets 404', async () => {
    const g = await gateway();
    const { token } = await setupAgent(g);
    const other = await setupAgent(g, 'bob');
    const approval = connectorApprovalSchema.parse((await create(g, token)).json());
    const path = `/v1/connectors/approvals/${approval.approval_id}`;
    expect((await g.send('GET', path, { headers: bearer(other.token) })).statusCode).toBe(404);
    expect((await g.send('DELETE', path, { headers: bearer(other.token) })).statusCode).toBe(404);
    expect((await g.send('DELETE', path, { headers: bearer(token) })).statusCode).toBe(204);
    expect((await g.send('GET', path, { headers: bearer(token) })).json()).toMatchObject({
      status: 'expired',
    });
    expect(
      (await g.send('GET', '/v1/connectors/approvals/not-an-id', { headers: bearer(token) }))
        .statusCode,
    ).toBe(404);
  });

  it('limits a computer to 30 requests a minute', async () => {
    const g = await gateway();
    const { token } = await setupAgent(g);
    const approval = connectorApprovalSchema.parse((await create(g, token)).json());
    const path = `/v1/connectors/approvals/${approval.approval_id}`;
    const codes: number[] = [];
    for (let i = 0; i < 30; i++)
      codes.push((await g.send('GET', path, { headers: bearer(token) })).statusCode);
    expect(codes.at(-1)).toBe(429);
  });

  it('refuses a bad token', async () => {
    const g = await gateway();
    expect((await create(g, `cct_${'z'.repeat(43)}`)).statusCode).toBe(401);
  });
});
