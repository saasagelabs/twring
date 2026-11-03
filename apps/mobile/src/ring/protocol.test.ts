import { describe, expect, it } from 'vitest';

import {
  declineRequestSchema,
  historyResponseSchema,
  inviteSchema,
  parsePush,
  registerDeviceRequestSchema,
  ringSettingsSchema,
} from './protocol';

const RING = {
  type: 'cord.ring',
  invite_id: 'inv_1',
  agent_id: 'agt_1',
  agent_name: 'Claude',
  reason: 'Deploy is blocked on your approval',
  expires_at: '2026-09-30T10:00:45.000Z',
  server_time: '2026-09-30T10:00:00.000Z',
};

describe('push payloads', () => {
  it('reads a ring and a ring cancel (all values are strings)', () => {
    expect(parsePush(RING)).toEqual(RING);
    expect(parsePush({ type: 'cord.ring_cancel', invite_id: 'inv_1', status: 'answered' })).toEqual(
      { type: 'cord.ring_cancel', invite_id: 'inv_1', status: 'answered' },
    );
  });

  it('ignores anything else or anything malformed', () => {
    expect(parsePush({ type: 'other' })).toBeUndefined();
    expect(parsePush({ ...RING, invite_id: '' })).toBeUndefined();
    expect(parsePush({ ...RING, expires_at: 'soon' })).toBeUndefined();
    expect(parsePush({ ...RING, agent_id: undefined })).toBeUndefined();
    expect(parsePush(null)).toBeUndefined();
    expect(parsePush('cord.ring')).toBeUndefined();
  });
});

describe('requests and responses', () => {
  it('registers an Android or iOS device for a known variant only', () => {
    expect(
      registerDeviceRequestSchema.safeParse({
        fcm_token: 't',
        platform: 'android',
        app_variant: 'staging',
      }).success,
    ).toBe(true);
    expect(
      registerDeviceRequestSchema.safeParse({
        fcm_token: 't',
        platform: 'ios',
        app_variant: 'staging',
      }).success,
    ).toBe(true);
    expect(
      registerDeviceRequestSchema.safeParse({
        fcm_token: '',
        platform: 'android',
        app_variant: 'staging',
      }).success,
    ).toBe(false);
  });

  it('reads ring settings with and without quiet hours', () => {
    expect(ringSettingsSchema.safeParse({ dnd: false, quiet_hours: null }).success).toBe(true);
    const quiet = { enabled: true, start: '22:00', end: '07:00', tz: 'Asia/Kolkata' };
    expect(ringSettingsSchema.safeParse({ dnd: true, quiet_hours: quiet }).success).toBe(true);
    expect(
      ringSettingsSchema.safeParse({ dnd: true, quiet_hours: { ...quiet, start: '24:00' } })
        .success,
    ).toBe(false);
    expect(
      ringSettingsSchema.safeParse({ dnd: true, quiet_hours: { ...quiet, end: '7:00' } }).success,
    ).toBe(false);
  });

  it('reads an invite in every status and rejects unknown ones', () => {
    const fields: Record<string, string> = { ...RING };
    delete fields.type;
    for (const status of ['pending', 'answered', 'declined', 'missed', 'cancelled']) {
      expect(inviteSchema.safeParse({ ...fields, status }).success).toBe(true);
    }
    expect(inviteSchema.safeParse({ ...fields, status: 'ringing' }).success).toBe(false);
  });

  it('limits a decline note to 60 characters', () => {
    expect(declineRequestSchema.safeParse({}).success).toBe(true);
    expect(declineRequestSchema.safeParse({ note: 'busy' }).success).toBe(true);
    expect(declineRequestSchema.safeParse({ note: 'x'.repeat(60) }).success).toBe(true);
    expect(declineRequestSchema.safeParse({ note: 'x'.repeat(61) }).success).toBe(false);
  });

  it('reads history with calls and missed invites mixed', () => {
    const parsed = historyResponseSchema.parse({
      calls: [
        {
          call_id: `call_${'a'.repeat(20)}`,
          agent_id: `agt_${'b'.repeat(20)}`,
          agent_name: 'Claude',
          started_at: '2026-09-30T09:00:00.000Z',
          duration_s: 42,
          outcome: 'completed',
          end_reason: 'hangup',
        },
        {
          // Exactly what the gateway records for a ring nobody answered (ADR-024).
          call_id: `inv_${'a'.repeat(26)}`,
          kind: 'missed_invite',
          agent_id: `agt_${'b'.repeat(20)}`,
          agent_name: 'Claude',
          reason: 'Deploy is blocked',
          started_at: '2026-09-30T10:00:00.000Z',
          duration_s: 0,
          outcome: 'missed',
        },
      ],
    });
    expect(parsed.calls.map((entry) => entry.kind)).toEqual([undefined, 'missed_invite']);
  });
});
