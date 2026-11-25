import { describe, expect, it } from 'vitest';

import { relayConnectorMessageSchema, relayGatewayMessageSchema } from './connectors';
import {
  messageAad,
  newMessageKey,
  openBody,
  openControl,
  sealBody,
  sealControl,
  sealedApprovalIdSchema,
} from './message-seal';
import { sealedApprovalDecisionRequestSchema, threadMessageSchema } from './threads';

const aad = messageAad({
  accountId: 'con_aaaaaaaaaaaaaaaaaaaa',
  agentId: 'claude-code',
  senderDevice: 'dev_aaaaaaaaaaaaaaaaaaaa',
  senderSeq: 4,
});
const APPROVAL_ID = `apv_${'b'.repeat(26)}`;
const envelope = {
  v: 1,
  sender_device: 'dev_aaaaaaaaaaaaaaaaaaaa',
  sender_seq: 4,
  nonce: 'abc',
  body: 'def',
  keys: [{ device: 'dev_aaaaaaaaaaaaaaaaaaaa', wrapped: 'ghi' }],
};

describe('sealed approvals (C3 #11)', () => {
  it('round-trips an approval request and a decision', () => {
    const key = newMessageKey();
    const request = {
      kind: 'approval' as const,
      approval_id: APPROVAL_ID,
      title: 'Run deploy.sh',
      description: 'Deploys to production',
      expires_at: '2026-11-25T10:00:00.000Z',
    };
    const sealed = sealControl(key, request, aad);
    expect(openControl(key, sealed.nonce, sealed.body, aad)).toEqual(request);
    const decision = {
      kind: 'approval_decision' as const,
      approval_id: APPROVAL_ID,
      decision: 'approve' as const,
    };
    const sealedDecision = sealControl(key, decision, aad);
    expect(openControl(key, sealedDecision.nonce, sealedDecision.body, aad)).toEqual(decision);
  });

  it('never opens a control payload as a message, or a message as a control payload', () => {
    const key = newMessageKey();
    const control = sealControl(
      key,
      { kind: 'approval_decision', approval_id: APPROVAL_ID, decision: 'deny' },
      aad,
    );
    expect(() => openBody(key, control.nonce, control.body, aad)).toThrow();
    const message = sealBody(key, { text: 'hi' }, aad);
    expect(() => openControl(key, message.nonce, message.body, aad)).toThrow();
  });

  it('refuses short approval ids and overlong titles', () => {
    expect(sealedApprovalIdSchema.safeParse('apv_abc').success).toBe(false);
    expect(sealedApprovalIdSchema.safeParse(APPROVAL_ID).success).toBe(true);
    expect(() =>
      sealControl(
        newMessageKey(),
        {
          kind: 'approval',
          approval_id: APPROVAL_ID,
          title: 'x'.repeat(141),
          expires_at: '2026-11-25T10:00:00.000Z',
        },
        aad,
      ),
    ).toThrow();
  });

  it('validates the new relay frames', () => {
    expect(
      relayConnectorMessageSchema.safeParse({
        type: 'sealed.approval',
        agent: 'claude-code',
        turn_id: 'msg_aaaaaaaaaaaaaaaaaaaa',
        sealed: envelope,
        expires_at: '2026-11-25T10:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      relayGatewayMessageSchema.safeParse({
        type: 'sealed.decision',
        agent: 'claude-code',
        message_id: 'msg_aaaaaaaaaaaaaaaaaaaa',
        sealed: envelope,
      }).success,
    ).toBe(true);
    expect(
      relayGatewayMessageSchema.safeParse({
        type: 'sealed.decision',
        agent: 'claude-code',
        message_id: 'msg_aaaaaaaaaaaaaaaaaaaa',
        sealed: envelope,
        decision: 'approve',
      }).success,
    ).toBe(false);
  });

  it('stores a sealed approval in a thread with metadata only', () => {
    const base = {
      id: 'msg_aaaaaaaaaaaaaaaaaaaa',
      agent_id: `agt_${'a'.repeat(20)}`,
      seq: 1,
      rev: 1,
      created_at: '2026-11-25T10:00:00.000Z',
      updated_at: '2026-11-25T10:00:00.000Z',
      kind: 'sealed',
      author: 'agent',
      sealed: [envelope],
    };
    expect(
      threadMessageSchema.safeParse({
        ...base,
        approval: { state: 'pending', expires_at: '2026-11-25T10:10:00.000Z' },
      }).success,
    ).toBe(true);
    expect(
      threadMessageSchema.safeParse({
        ...base,
        approval: { state: 'pending', expires_at: '2026-11-25T10:10:00.000Z', title: 'x' },
      }).success,
    ).toBe(false);
    expect(sealedApprovalDecisionRequestSchema.safeParse({ sealed: envelope }).success).toBe(true);
    expect(
      sealedApprovalDecisionRequestSchema.safeParse({ sealed: envelope, decision: 'approve' })
        .success,
    ).toBe(false);
  });
});
