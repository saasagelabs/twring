import { describe, expect, it } from 'vitest';

import { agentEventSchema } from './agent';
import { nativeClientMessageSchema, nativeSessionReadySchema } from './native-protocol';
import { statusMessageSchema } from './realtime';

describe('approval contracts', () => {
  const base = { event_id: 'evt_1', turn_id: 'turn_1', approval_id: 'apr_1' };

  it('parses agent approval events and rejects invalid actions, title, and resolution', () => {
    expect(
      agentEventSchema.safeParse({
        ...base,
        type: 'approval.required',
        action: 'edit_files',
        title: 'Edit',
      }).success,
    ).toBe(true);
    expect(
      agentEventSchema.safeParse({
        ...base,
        type: 'approval.required',
        action: 'shell',
        title: 'Edit',
      }).success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({
        ...base,
        type: 'approval.required',
        action: 'edit_files',
        title: '',
      }).success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({
        ...base,
        type: 'approval.required',
        action: 'edit_files',
        title: 'x'.repeat(81),
      }).success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({
        ...base,
        type: 'approval.required',
        action: 'edit_files',
        title: '😀'.repeat(80),
      }).success,
    ).toBe(true);
    expect(
      agentEventSchema.safeParse({
        ...base,
        type: 'approval.resolved',
        decision: 'deny',
        by: 'timeout',
      }).success,
    ).toBe(true);
    expect(
      agentEventSchema.safeParse({
        ...base,
        type: 'approval.resolved',
        decision: 'later',
        by: 'timeout',
      }).success,
    ).toBe(false);
  });

  it('parses the gateway decision and approval capability', () => {
    expect(
      nativeClientMessageSchema.safeParse({
        type: 'approval.decision',
        turn_id: 'turn_1',
        approval_id: 'apr_1',
        decision: 'approve',
      }).success,
    ).toBe(true);
    expect(
      nativeClientMessageSchema.safeParse({
        type: 'approval.decision',
        turn_id: '',
        approval_id: 'apr_1',
        decision: 'approve',
      }).success,
    ).toBe(false);
    expect(
      nativeClientMessageSchema.safeParse({
        type: 'approval.decision',
        turn_id: 'turn_1',
        approval_id: 'apr_1',
        decision: 'yes',
      }).success,
    ).toBe(false);
    expect(
      nativeSessionReadySchema.safeParse({
        type: 'session.ready',
        protocol: 'cord-agent/1',
        capabilities: { approvals: true },
      }).success,
    ).toBe(true);
  });

  it('parses realtime approval and resolved messages', () => {
    const approval = {
      v: 1,
      type: 'approval',
      call_id: 'call_1',
      approval_id: 'apr_1',
      agent_name: 'Hermes',
      action: 'delete_files',
      title: 'Delete files',
      expires_at: '2026-10-06T12:00:00.000Z',
    };
    expect(statusMessageSchema.safeParse(approval).success).toBe(true);
    expect(statusMessageSchema.safeParse({ ...approval, expires_at: 'tomorrow' }).success).toBe(
      false,
    );
    expect(
      statusMessageSchema.safeParse({ ...approval, description: 'x'.repeat(201) }).success,
    ).toBe(false);
    expect(
      statusMessageSchema.safeParse({
        v: 1,
        type: 'approval_resolved',
        call_id: 'call_1',
        approval_id: 'apr_1',
        decision: 'deny',
        by: 'tap',
      }).success,
    ).toBe(true);
    expect(
      statusMessageSchema.safeParse({
        v: 1,
        type: 'approval_resolved',
        call_id: 'call_1',
        approval_id: 'apr_1',
        decision: 'deny',
        by: 'agent',
      }).success,
    ).toBe(false);
  });
});
