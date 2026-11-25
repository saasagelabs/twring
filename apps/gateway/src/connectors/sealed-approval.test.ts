/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  APPROVAL_HOLD_MS,
  deviceIdFor,
  generateSealKeyPair,
  messageAad,
  messagePageResponseSchema,
  newMessageKey,
  sealControl,
  SEALED_CHAT_FEATURE,
  wrapKey,
  type SealedControlPayload,
  type SealedEnvelopeV1,
} from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from './harness';

/** Sealed approvals in private chats (C3 #11): the server relays and stores ciphertext only. */

const FLAG_ON = { PRIVATE_CHATS_ENABLED: 'true', THREADS_ENABLED: 'true' };
const TITLE = 'Use sk-live-TITLEMARKER to deploy';
const DESCRIPTION = 'DESCRIPTIONMARKER production';
const phoneKeys = generateSealKeyPair();
const computerKeys = generateSealKeyPair();
const PHONE = deviceIdFor(phoneKeys.publicKey);
const COMPUTER = deviceIdFor(computerKeys.publicKey);
let seq = 0;

/** A real sealed envelope, as the computer or phone makes it. */
function seal(
  connectorId: string,
  from: 'phone' | 'computer',
  payload: SealedControlPayload | { text: string },
): SealedEnvelopeV1 {
  const me = from === 'phone' ? phoneKeys : computerKeys;
  const sender = from === 'phone' ? PHONE : COMPUTER;
  const senderSeq = ++seq;
  const aad = messageAad({
    accountId: connectorId,
    agentId: 'claude-code',
    senderDevice: sender,
    senderSeq,
  });
  const key = newMessageKey();
  const { nonce, body } =
    'kind' in payload
      ? sealControl(key, payload, aad)
      : { nonce: 'bm9uY2Vub25jZQ', body: 'Y2lwaGVydGV4dA' };
  return {
    v: 1,
    sender_device: sender,
    sender_seq: senderSeq,
    nonce,
    body,
    keys: [
      { device: PHONE, wrapped: wrapKey(key, me.privateKey, phoneKeys.publicKey, aad) },
      { device: COMPUTER, wrapped: wrapKey(key, me.privateKey, computerKeys.publicKey, aad) },
    ],
  };
}

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function privateTurn() {
  const g = await startConnectorGateway({ threads: {}, ring: {}, env: FLAG_ON });
  gateways.push(g);
  const lines: string[] = [];
  const log = vi.fn((fields: Record<string, unknown>) => lines.push(JSON.stringify(fields)));
  (g.threads!.service as unknown as { options: { log: unknown } }).options.log = {
    info: log,
    warn: log,
  };
  const { connectorId, connector } = await g.connect('u1', { features: [SEALED_CHAT_FEATURE] });
  const agentId = await g.createAgent('u1', connectorId);
  await g.send('PUT', `/v1/agents/${agentId}/private`, {
    user: 'u1',
    body: { on: true },
    headers: { 'x-twring-features': SEALED_CHAT_FEATURE },
  });
  const posted = await g.send('POST', `/v1/agents/${agentId}/messages`, {
    user: 'u1',
    body: { client_id: randomUUID(), sealed: seal(connectorId, 'phone', { text: 'go' }) },
  });
  const turnId: string = posted.json().message.id;
  await waitFor(() => connector.sealed.length === 1);
  const list = async () =>
    messagePageResponseSchema.parse(
      (await g.send('GET', `/v1/agents/${agentId}/messages`, { user: 'u1' })).json(),
    ).messages;
  const approvalId = `apv_${'q'.repeat(26)}`;
  const ask = (overrides: Record<string, unknown> = {}) => {
    const expiresAt = new Date(Date.now() + APPROVAL_HOLD_MS).toISOString();
    connector.send({
      type: 'sealed.approval',
      agent: 'claude-code',
      turn_id: turnId,
      sealed: seal(connectorId, 'computer', {
        kind: 'approval',
        approval_id: approvalId,
        title: TITLE,
        description: DESCRIPTION,
        expires_at: expiresAt,
      }),
      expires_at: expiresAt,
      ...overrides,
    });
  };
  const stored = async () =>
    (await list()).find((m) => m.kind === 'sealed' && m.approval !== undefined);
  const decide = async (messageId: string, body: Record<string, unknown>) => {
    const res = await g.send('POST', `/v1/agents/${agentId}/approvals/${messageId}`, {
      user: 'u1',
      body,
    });
    return { status: res.statusCode, json: res.json() };
  };
  const decision = (decision: 'approve' | 'deny') =>
    seal(connectorId, 'phone', { kind: 'approval_decision', approval_id: approvalId, decision });
  return { g, connector, connectorId, agentId, turnId, list, ask, stored, decide, decision, lines };
}

describe('sealed approvals (C3 #11)', () => {
  it('stores the request as an opaque pending sealed message and pushes the fixed text', async () => {
    const t = await privateTurn();
    const push = vi.spyOn(t.g.ring!.service, 'pushMessage');
    t.ask();
    await waitFor(async () => (await t.stored()) !== undefined);
    const message = (await t.stored())!;
    expect(message).toMatchObject({ kind: 'sealed', author: 'agent' });
    if (message.kind !== 'sealed') throw new Error('not sealed');
    expect(message.approval?.state).toBe('pending');
    await waitFor(() => push.mock.calls.length === 1);
    expect(push.mock.calls[0]![1].preview).toBe('New message');
    // The server holds no readable title, description or answer anywhere.
    const db = (t.g.threads!.store as unknown as { db: DatabaseSync }).db;
    const rows = JSON.stringify(db.prepare('SELECT * FROM messages').all());
    for (const seen of [
      rows,
      JSON.stringify(await t.list()),
      JSON.stringify(push.mock.calls),
      t.lines.join('\n'),
    ]) {
      expect(seen).not.toContain('TITLEMARKER');
      expect(seen).not.toContain('DESCRIPTIONMARKER');
    }
  });

  it('relays the sealed answer unchanged and marks the request answered only', async () => {
    const t = await privateTurn();
    t.ask();
    await waitFor(async () => (await t.stored()) !== undefined);
    const message = (await t.stored())!;
    const sealed = t.decision('approve');
    const res = await t.decide(message.id, { sealed });
    expect(res.status).toBe(200);
    expect(res.json.message.approval.state).toBe('answered');
    await waitFor(() => t.connector.decisions.length === 1);
    expect(t.connector.decisions[0]).toEqual({
      type: 'sealed.decision',
      agent: 'claude-code',
      message_id: message.id,
      sealed,
    });
    const all = JSON.stringify(await t.list()) + t.lines.join('\n');
    expect(all).not.toMatch(/"(approve|allowed|denied)"/);
    // A second answer is refused: the server never relays two.
    const again = await t.decide(message.id, { sealed: t.decision('deny') });
    expect(again.status).toBe(409);
    expect(t.connector.decisions).toHaveLength(1);
  });

  it('refuses a plain decision for a sealed approval: only the phone answers it', async () => {
    const t = await privateTurn();
    t.ask();
    await waitFor(async () => (await t.stored()) !== undefined);
    const res = await t.decide((await t.stored())!.id, { decision: 'approve' });
    expect(res.status).toBe(404);
    expect(t.connector.decisions).toHaveLength(0);
  });

  it('refuses a sealed answer to a message that is not a sealed approval', async () => {
    const t = await privateTurn();
    const res = await t.decide(t.turnId, { sealed: t.decision('approve') });
    expect(res.status).toBe(404);
    expect(t.connector.decisions).toHaveLength(0);
  });

  it('refuses an answer after the request expired', async () => {
    const t = await privateTurn();
    t.ask();
    await waitFor(async () => (await t.stored()) !== undefined);
    const message = (await t.stored())!;
    const later = Date.now() + APPROVAL_HOLD_MS + 1;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      const res = await t.decide(message.id, { sealed: t.decision('approve') });
      expect(res.status).toBe(409);
    } finally {
      vi.restoreAllMocks();
    }
    expect(t.connector.decisions).toHaveLength(0);
  });

  it('says so when the computer is not connected, and keeps the request pending', async () => {
    const t = await privateTurn();
    t.ask();
    await waitFor(async () => (await t.stored()) !== undefined);
    const message = (await t.stored())!;
    t.connector.terminate();
    await waitFor(() => !t.g.hub.isOnline('u1', t.connectorId));
    const res = await t.decide(message.id, { sealed: t.decision('approve') });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('agent_offline');
    const after = (await t.stored())!;
    expect(after.kind === 'sealed' && after.approval?.state).toBe('pending');
  });

  it('drops a request for an unknown turn or one held too long', async () => {
    const t = await privateTurn();
    t.ask({ turn_id: `msg_${'z'.repeat(20)}` });
    const far = new Date(Date.now() + 2 * APPROVAL_HOLD_MS).toISOString();
    t.ask({ expires_at: far });
    await waitFor(() => t.lines.filter((l) => l.includes('e2e_approval_rejected')).length === 2);
    expect(await t.stored()).toBeUndefined();
  });
});
