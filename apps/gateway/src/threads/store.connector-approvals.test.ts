import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { CredentialCipher, messageKeys } from '../store/cipher';
import { SqliteThreadStore, ThreadStoreError } from './store';

const cipher = new CredentialCipher(
  messageKeys({ currentVersion: 1, keys: new Map([[1, randomBytes(32).toString('base64')]]) }),
);
const A = `agt_${'a'.repeat(20)}`;
let at = new Date('2026-11-28T10:00:00.000Z');
const stores: SqliteThreadStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  at = new Date('2026-11-28T10:00:00.000Z');
});
function store() {
  const s = new SqliteThreadStore(':memory:', cipher, () => at);
  stores.push(s);
  return s;
}
const card = (requestId: string, expiresAt = '2026-11-28T10:05:00.000Z') => ({
  kind: 'approval' as const,
  approval_id: requestId,
  title: 'Run a command (from Telegram)',
  description: 'rm -rf build',
  status: 'pending' as const,
  expires_at: expiresAt,
  clientId: `connector:con_1:${requestId}`,
  meta: { origin: 'connector' as const, request_id: requestId, connector_id: 'con_1' },
  maxPending: 3,
});

describe('connector approvals in the store', () => {
  it('appends once per client id and returns the same card on a repeat', async () => {
    const s = store();
    const first = await s.appendMessage('u1', A, card('req-1'));
    const again = await s.appendMessage('u1', A, card('req-1'));
    expect(first.created).toBe(true);
    expect(again).toEqual({ message: first.message, created: false });
    const page = await s.listMessages('u1', A, { limit: 50 });
    expect(page.messages.filter((m) => m.kind === 'approval')).toHaveLength(1);
  });

  it('keeps origin, request and connector in meta but never in the message', async () => {
    const s = store();
    const { message } = await s.appendMessage('u1', A, card('req-1'));
    expect(message).not.toHaveProperty('origin');
    expect(message).not.toHaveProperty('connector_id');
    expect(await s.findConnectorApproval('u1', message.id)).toEqual({
      agentId: A,
      message,
      connectorId: 'con_1',
      requestId: 'req-1',
    });
    expect(await s.findConnectorApproval('u2', message.id)).toBeUndefined();
  });

  it('ignores relay approvals (no connector origin)', async () => {
    const s = store();
    const relay = await s.appendMessage('u1', A, {
      kind: 'approval',
      approval_id: 'apr-1',
      title: 'Run the report',
      status: 'pending',
      expires_at: '2026-11-28T10:10:00.000Z',
    });
    expect(await s.findConnectorApproval('u1', relay.id)).toBeUndefined();
  });

  it('refuses a fourth unexpired pending approval, and counts expired ones out', async () => {
    const s = store();
    for (const id of ['r1', 'r2', 'r3']) await s.appendMessage('u1', A, card(id));
    await expect(s.appendMessage('u1', A, card('r4'))).rejects.toEqual(
      new ThreadStoreError('approvals_full'),
    );
    // A repeat of a stored one is not a new approval.
    expect((await s.appendMessage('u1', A, card('r1'))).created).toBe(false);
    at = new Date('2026-11-28T10:06:00.000Z');
    expect((await s.appendMessage('u1', A, card('r4', '2026-11-28T10:16:00.000Z'))).created).toBe(
      true,
    );
  });

  it('expires connector approvals at start-up like every other approval', async () => {
    const s = store();
    const { message } = await s.appendMessage('u1', A, card('req-1'));
    await s.expirePendingApprovals();
    expect((await s.findConnectorApproval('u1', message.id))?.message.status).toBe('expired');
  });
});
