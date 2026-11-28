import {
  declineRequestSchema as gatewayDeclineSchema,
  deviceIdSchema,
  deviceRegistrationSchema,
  inviteSchema as gatewayInviteSchema,
  ringSettingsSchema as gatewayRingSettingsSchema,
  type Invite as GatewayInvite,
  type RingCancelPush as GatewayCancelPush,
  type RingPush as GatewayRingPush,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { checkNote } from './decline-note';
import { missedCallRow } from './history';
import { inviteFrom } from './invite-state';
import { inviteSchema, parsePush, registerDeviceRequestSchema } from './protocol';
import { PushRegistration, type PushRegistrationDeps } from './push-registration';
import { settingsFromForm } from './settings';

/** Verifier edge cases: phone vs gateway shapes, and the ring's small helpers. */

const INVITE_ID = `inv_${'a'.repeat(26)}`;
const AGENT_ID = `agt_${'b'.repeat(20)}`;
/** The shape of a real FCM registration token (instance id, colon, APA91 token). */
const FCM_TOKEN = `fGx2kX5dQ5e0b8Yh2mZ4Qe:APA91bF${'Xy9_-Zq3'.repeat(18)}`;

describe('phone requests are what the gateway accepts', () => {
  it('device registration, with a real-looking FCM token and this app’s device id', () => {
    const request = registerDeviceRequestSchema.parse({
      fcm_token: FCM_TOKEN,
      platform: 'android',
      app_variant: 'production',
    });
    expect(deviceRegistrationSchema.safeParse(request).success).toBe(true);
    expect(deviceIdSchema.safeParse(`android-${'0123456789abcdef'.repeat(2)}`).success).toBe(true);
  });

  it('ring settings from the form, with and without quiet hours', () => {
    for (const quietEnabled of [true, false]) {
      const checked = settingsFromForm(
        { dnd: false, quietEnabled, start: '7:05', end: '2230' },
        'Asia/Kolkata',
        { dnd: false, quiet_hours: { enabled: true, start: '22:00', end: '07:00', tz: 'UTC' } },
      );
      if (!checked.ok) throw new Error(checked.field);
      expect(gatewayRingSettingsSchema.safeParse(checked.settings).success).toBe(true);
    }
    const never = settingsFromForm(
      { dnd: true, quietEnabled: false, start: '', end: '' },
      'Asia/Kolkata',
    );
    if (!never.ok) throw new Error(never.field);
    expect(gatewayRingSettingsSchema.parse(never.settings)).toEqual({
      dnd: true,
      quiet_hours: null,
    });
  });

  it('decline notes the phone lets through are notes the gateway keeps', () => {
    for (const text of ['busy', 'outside', 'text', '😀'.repeat(30), `${'x'.repeat(59)}é`]) {
      const checked = checkNote(text);
      if (!checked.ok) continue;
      const parsed = gatewayDeclineSchema.safeParse({ note: checked.note });
      expect(parsed.success).toBe(true);
    }
    // 31 emoji are 31 characters but 62 UTF-16 units: the phone refuses, like the gateway would.
    expect(checkNote('😀'.repeat(31)).ok).toBe(false);
  });
});

describe('gateway responses and pushes are what the phone reads', () => {
  const invite: GatewayInvite = {
    invite_id: INVITE_ID,
    agent_id: AGENT_ID,
    agent_name: 'Laptop Claude',
    reason: 'Tests pass; can I push?',
    status: 'pending',
    expires_at: '2026-10-01T09:00:30.000Z',
    server_time: '2026-10-01T09:00:05.000Z',
  };

  it('an invite', () => {
    expect(gatewayInviteSchema.parse(invite)).toEqual(inviteSchema.parse(invite));
  });

  it('cord.ring and cord.ring_cancel for every status', () => {
    const ring: GatewayRingPush = { type: 'cord.ring', ...invite };
    delete (ring as Partial<GatewayInvite>).status;
    expect(parsePush(ring)?.type).toBe('cord.ring');
    for (const status of ['answered', 'declined', 'missed', 'cancelled'] as const) {
      const cancel: GatewayCancelPush = { type: 'cord.ring_cancel', invite_id: INVITE_ID, status };
      expect(parsePush(cancel)).toEqual(cancel);
    }
  });

  it('counts down from server time, however late the push arrived', () => {
    // The push says 25 s were left when it was sent; it arrives on a phone whose clock is 1 h off.
    const phoneNow = Date.parse('2026-10-01T10:00:00.000Z');
    expect(inviteFrom(invite, phoneNow).expiresAt - phoneNow).toBe(25_000);
  });
});

describe('missed-call line', () => {
  it('never cuts an emoji in half', () => {
    const row = missedCallRow(
      {
        call_id: INVITE_ID,
        kind: 'missed_invite',
        agent_id: AGENT_ID,
        agent_name: 'Claude',
        reason: `${'a'.repeat(47)}😀 then more words after the cut`,
        started_at: '2026-09-30T10:25:00.000Z',
        duration_s: 0,
        outcome: 'missed',
      },
      new Date('2026-09-30T10:30:00.000Z'),
    );
    const halves = Array.from(row.line).filter(
      (c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff,
    );
    expect(halves).toEqual([]);
    expect(row.line.endsWith('…')).toBe(true);
  });
});

describe('push registration after Delete my data', () => {
  it('registers the phone again, since the server removed it', async () => {
    const deps = {
      getToken: vi.fn<PushRegistrationDeps['getToken']>().mockResolvedValue(FCM_TOKEN),
      deviceId: vi.fn<PushRegistrationDeps['deviceId']>().mockResolvedValue('android-1234567890'),
      register: vi.fn<PushRegistrationDeps['register']>().mockResolvedValue(undefined),
      unregister: vi.fn<PushRegistrationDeps['unregister']>().mockResolvedValue(undefined),
      setRingAccount: vi.fn<PushRegistrationDeps['setRingAccount']>(),
      deleteToken: vi.fn<PushRegistrationDeps['deleteToken']>().mockResolvedValue(undefined),
      getPendingDeviceId: vi
        .fn<PushRegistrationDeps['getPendingDeviceId']>()
        .mockResolvedValue(null),
      setPendingDeviceId: vi
        .fn<PushRegistrationDeps['setPendingDeviceId']>()
        .mockResolvedValue(undefined),
      appVariant: 'production' as const,
    };
    const registration = new PushRegistration(deps);
    await registration.signedIn('user-1');
    expect(deps.register).toHaveBeenCalledTimes(1);
    // Delete my data (still signed in): the gateway deleted this phone's registration.
    registration.forget();
    // The next app start or return to the foreground.
    await registration.signedIn('user-1');
    expect(deps.register).toHaveBeenCalledTimes(2);
  });
});
