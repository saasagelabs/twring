import { describe, expect, it, vi } from 'vitest';
import { userRef } from '@twring/contracts';

import { ApiError } from '../api/client';

import { checkNote, charactersLeft, QUICK_REPLIES } from './decline-note';
import { flushDeclines, sendDecline } from './declines';
import { historyListRow, missedCallRow } from './history';
import {
  answerFailure,
  expiryOnPhone,
  INITIAL_INCOMING,
  inviteFrom,
  reduceIncoming,
  secondsLeft,
  type IncomingEvent,
  type IncomingState,
} from './invite-state';
import { PUSH_REFRESH_MS, PushRegistration, type PushRegistrationDeps } from './push-registration';
import {
  formFromSettings,
  normalizeClock,
  persistRingSettings,
  ringSummary,
  settingsFromForm,
} from './settings';

const run = (events: IncomingEvent[], from: IncomingState = INITIAL_INCOMING) =>
  events.reduce(reduceIncoming, from);

describe('invite state', () => {
  it('rings once the server says pending, and ends at expiry on the phone clock', () => {
    const ringing = run([{ type: 'LOADED', status: 'pending' }]);
    expect(ringing).toEqual({ phase: 'ringing' });
    expect(reduceIncoming(ringing, { type: 'TICK', now: 999, expiresAt: 1000 })).toBe(ringing);
    expect(reduceIncoming(ringing, { type: 'TICK', now: 1000, expiresAt: 1000 })).toEqual({
      phase: 'ended',
      why: 'expired',
    });
  });

  it('shows what happened to an invite that is no longer pending', () => {
    expect(run([{ type: 'LOADED', status: 'answered' }])).toEqual({
      phase: 'ended',
      why: 'answered_elsewhere',
    });
    expect(run([{ type: 'LOADED', status: 'missed' }])).toEqual({ phase: 'ended', why: 'missed' });
    expect(run([{ type: 'LOADED', status: 'cancelled' }])).toEqual({
      phase: 'ended',
      why: 'cancelled',
    });
  });

  it('stops ringing on ring_cancel, but not for its own answer or decline', () => {
    const ringing: IncomingState = { phase: 'ringing' };
    expect(reduceIncoming(ringing, { type: 'CANCELLED', status: 'answered' })).toEqual({
      phase: 'ended',
      why: 'answered_elsewhere',
    });
    expect(reduceIncoming(ringing, { type: 'CANCELLED', status: 'cancelled' })).toEqual({
      phase: 'ended',
      why: 'cancelled',
    });
    const answering = reduceIncoming(ringing, { type: 'ANSWER' });
    expect(reduceIncoming(answering, { type: 'CANCELLED', status: 'answered' })).toBe(answering);
    const declining = reduceIncoming(ringing, { type: 'DECLINE' });
    expect(reduceIncoming(declining, { type: 'CANCELLED', status: 'declined' })).toBe(declining);
    expect(reduceIncoming(declining, { type: 'DECLINE_DONE' })).toEqual({
      phase: 'ended',
      why: 'declined',
    });
  });

  it('maps answer failures: 410 expired, 409 already handled, call errors retryable', () => {
    expect(answerFailure(new ApiError('http', undefined, 'r', undefined, 410))).toEqual({
      phase: 'ended',
      why: 'expired',
    });
    expect(answerFailure(new ApiError('http', undefined, 'r', undefined, 409))).toEqual({
      phase: 'ended',
      why: 'answered_elsewhere',
    });
    const busy = answerFailure(new ApiError('http', 'call_in_progress', 'r', undefined, 409));
    expect(busy.phase).toBe('failed');
    const offline = answerFailure(new ApiError('http', 'agent_offline', 'r', undefined, 409));
    expect(offline.phase).toBe('failed');
    const limit = answerFailure(new ApiError('http', 'daily_limit_reached', 'r', undefined, 429));
    expect(limit.phase).toBe('failed');
    expect(answerFailure(new ApiError('network')).phase).toBe('failed');
  });

  it('can retry answering after a call error, and expiry still ends it', () => {
    const failed = run(
      [{ type: 'ANSWER' }, { type: 'ANSWER_FAILED', error: new ApiError('network') }],
      {
        phase: 'ringing',
      },
    );
    expect(failed.phase).toBe('failed');
    expect(reduceIncoming(failed, { type: 'ANSWER' })).toEqual({ phase: 'answering' });
    expect(reduceIncoming(failed, { type: 'TICK', now: 5, expiresAt: 5 })).toEqual({
      phase: 'ended',
      why: 'expired',
    });
  });

  it('keeps ringing from the push when the server cannot be reached, but not for a gone invite', () => {
    expect(run([{ type: 'LOAD_FAILED', error: new ApiError('network') }])).toEqual({
      phase: 'ringing',
    });
    expect(
      run([{ type: 'LOAD_FAILED', error: new ApiError('http', 'not_found', 'r', undefined, 404) }]),
    ).toEqual({ phase: 'ended', why: 'not_found' });
  });

  it('ignores everything once ended, and a late server answer after acting', () => {
    const ended: IncomingState = { phase: 'ended', why: 'declined' };
    expect(reduceIncoming(ended, { type: 'ANSWER' })).toBe(ended);
    expect(reduceIncoming(ended, { type: 'LOADED', status: 'pending' })).toBe(ended);
    const answering: IncomingState = { phase: 'answering' };
    expect(reduceIncoming(answering, { type: 'LOADED', status: 'pending' })).toBe(answering);
    expect(reduceIncoming(answering, { type: 'TICK', now: 10, expiresAt: 1 })).toBe(answering);
  });

  it('counts down on the phone clock whatever the phone clock says', () => {
    // The phone is 10 minutes behind; the server gives 45 s.
    const received = Date.parse('2026-09-30T09:50:00.000Z');
    const expiresAt = expiryOnPhone(
      '2026-09-30T10:00:45.000Z',
      '2026-09-30T10:00:00.000Z',
      received,
    );
    expect(expiresAt - received).toBe(45_000);
    expect(secondsLeft(expiresAt, received + 44_001)).toBe(1);
    expect(secondsLeft(expiresAt, received + 50_000)).toBe(0);
    const invite = inviteFrom(
      {
        type: 'cord.ring',
        invite_id: 'inv_1',
        agent_id: 'agt_1',
        agent_name: '  ',
        reason: ' Deploy ',
        expires_at: '2026-09-30T10:00:45.000Z',
        server_time: '2026-09-30T10:00:00.000Z',
      },
      received,
    );
    expect(invite).toMatchObject({ agentName: 'Your agent', reason: 'Deploy', expiresAt });
  });
});

describe('decline notes', () => {
  it('has the three quick replies', () => {
    expect(QUICK_REPLIES.map((reply) => reply.note)).toEqual(['busy', 'outside', 'text']);
  });

  it('trims, flattens to one line, and caps at 60 characters', () => {
    expect(checkNote('  on my way\nhome  ')).toEqual({ ok: true, note: 'on my way home' });
    expect(checkNote('   ')).toEqual({ ok: false, reason: 'empty', length: 0 });
    expect(checkNote('x'.repeat(60))).toEqual({ ok: true, note: 'x'.repeat(60) });
    expect(checkNote('x'.repeat(61))).toMatchObject({ ok: false, reason: 'too_long' });
    expect(checkNote('a\u0000b').ok).toBe(true);
    expect(charactersLeft('hello')).toBe(55);
  });
});

describe('declines', () => {
  it('treats a handled or expired invite as done, and retries only network failures', async () => {
    const ok = vi.fn().mockResolvedValue(undefined);
    expect(await sendDecline(ok, 'inv_1', { note: 'busy' })).toBe('sent');
    expect(ok).toHaveBeenCalledWith('inv_1', { note: 'busy' });
    const gone = vi.fn().mockRejectedValue(new ApiError('http', undefined, 'r', undefined, 410));
    expect(await sendDecline(gone, 'inv_1')).toBe('already_over');
    const handled = vi.fn().mockRejectedValue(new ApiError('http', undefined, 'r', undefined, 409));
    expect(await sendDecline(handled, 'inv_1')).toBe('already_over');
    const offline = vi.fn().mockRejectedValue(new ApiError('network'));
    expect(await sendDecline(offline, 'inv_1')).toBe('retry_later');
    const server = vi.fn().mockRejectedValue(new ApiError('http', undefined, 'r', undefined, 503));
    expect(await sendDecline(server, 'inv_1')).toBe('retry_later');
  });

  it('flushes the native queue once per invite and requeues what failed', async () => {
    const requeue = vi.fn();
    const decline = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ApiError('timeout'));
    const outcomes = await flushDeclines(
      { take: () => ['inv_1', 'inv_2', 'inv_1'], requeue },
      decline,
    );
    expect(outcomes).toEqual({ inv_1: 'sent', inv_2: 'retry_later' });
    expect(decline).toHaveBeenCalledTimes(2);
    expect(decline).toHaveBeenCalledWith('inv_1', {});
    expect(requeue).toHaveBeenCalledWith('inv_2');
  });
});

describe('push registration', () => {
  function setup(token: string | null = 'tok_1') {
    const deps = {
      getToken: vi.fn<PushRegistrationDeps['getToken']>().mockResolvedValue(token),
      deviceId: vi.fn<PushRegistrationDeps['deviceId']>().mockResolvedValue('dev_1'),
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
      appVariant: 'staging' as const,
    };
    return { deps, registration: new PushRegistration(deps) };
  }

  it('retries a failed registration after 2, 8 and 30 s, and stops once it works (review finding 6)', async () => {
    vi.useFakeTimers();
    try {
      const { deps, registration } = setup();
      deps.register
        .mockRejectedValueOnce(new Error('429'))
        .mockRejectedValueOnce(new Error('429'))
        .mockResolvedValue(undefined);
      await registration.signedIn('user-1');
      expect(deps.register).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(deps.register).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(deps.register).toHaveBeenCalledTimes(3);
      expect(registration.registered).toBe('tok_1');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.register).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying once signed out', async () => {
    vi.useFakeTimers();
    try {
      const { deps, registration } = setup();
      deps.register.mockRejectedValue(new Error('offline'));
      await registration.signedIn('user-1');
      await registration.signedOut();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.register).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('iOS: registers the VoIP token with the alert token, and again when the alert token arrives', async () => {
    const { deps } = setup('a'.repeat(64));
    let alert: string | null = null;
    const registration = new PushRegistration({
      ...deps,
      platform: 'ios',
      getAlertToken: () => Promise.resolve(alert),
    });
    await registration.signedIn('user-1');
    expect(deps.register).toHaveBeenLastCalledWith('dev_1', {
      fcm_token: 'a'.repeat(64),
      platform: 'ios',
      app_variant: 'staging',
    });
    alert = 'b'.repeat(64);
    await registration.alertTokenRefreshed();
    expect(deps.register).toHaveBeenLastCalledWith('dev_1', {
      fcm_token: 'a'.repeat(64),
      platform: 'ios',
      app_variant: 'staging',
      apns_token: 'b'.repeat(64),
    });
    await registration.alertTokenRefreshed();
    expect(deps.register).toHaveBeenCalledTimes(2);
  });

  it('iOS: an alert token after sign-out registers nothing', async () => {
    const { deps } = setup('a'.repeat(64));
    const registration = new PushRegistration({
      ...deps,
      platform: 'ios',
      getAlertToken: () => Promise.resolve('b'.repeat(64)),
    });
    await registration.signedIn('user-1');
    await registration.signedOut();
    await registration.alertTokenRefreshed();
    expect(deps.register).toHaveBeenCalledTimes(1);
  });

  it('registers the same token again on return at most once per 12 h', async () => {
    let now = 1_000_000;
    const { deps } = setup();
    const registration = new PushRegistration({ ...deps, now: () => now });
    await registration.signedIn('user-1');
    now += PUSH_REFRESH_MS - 1;
    await registration.signedIn('user-1');
    expect(deps.register).toHaveBeenCalledTimes(1);
    now += 1;
    await registration.signedIn('user-1');
    expect(deps.register).toHaveBeenCalledTimes(2);
    await registration.signedIn('user-1');
    expect(deps.register).toHaveBeenCalledTimes(2);
  });

  it('a failed re-registration is retried on the next return, not 12 h later', async () => {
    let now = 1_000_000;
    const { deps } = setup();
    const registration = new PushRegistration({ ...deps, now: () => now });
    await registration.signedIn('user-1');
    now += PUSH_REFRESH_MS;
    deps.register.mockRejectedValueOnce(new Error('offline'));
    await registration.signedIn('user-1');
    await registration.signedIn('user-1');
    expect(deps.register).toHaveBeenCalledTimes(3);
  });

  it('registers on sign-in, once per token', async () => {
    const { deps, registration } = setup();
    await registration.signedIn('user-1');
    await registration.signedIn('user-1');
    expect(deps.register).toHaveBeenCalledTimes(1);
    expect(deps.register).toHaveBeenCalledWith('dev_1', {
      fcm_token: 'tok_1',
      platform: 'android',
      app_variant: 'staging',
    });
  });

  it('re-registers a refreshed token, but only while signed in', async () => {
    const { deps, registration } = setup();
    await registration.tokenRefreshed('tok_0');
    expect(deps.register).not.toHaveBeenCalled();
    await registration.signedIn('user-1');
    await registration.tokenRefreshed('tok_2');
    expect(deps.register).toHaveBeenLastCalledWith(
      'dev_1',
      expect.objectContaining({ fcm_token: 'tok_2' }),
    );
    expect(registration.registered).toBe('tok_2');
  });

  it('unregisters on sign-out; a sign-in still queued behind it registers nothing', async () => {
    const { deps, registration } = setup();
    const order: string[] = [];
    deps.register.mockImplementation(() => {
      order.push('register');
      return Promise.resolve();
    });
    deps.unregister.mockImplementation(() => {
      order.push('unregister');
      return Promise.resolve();
    });
    void registration.signedIn('user-1');
    await registration.signedOut();
    expect(order).toEqual(['unregister']);
    expect(registration.registered).toBeUndefined();
    // Nothing more after sign-out.
    await registration.tokenRefreshed('tok_3');
    await registration.signedOut();
    expect(deps.register).not.toHaveBeenCalled();
    expect(deps.unregister).toHaveBeenCalledTimes(1);
  });

  it('unregisters after a completed registration', async () => {
    const { deps, registration } = setup();
    await registration.signedIn('user-1');
    await registration.signedOut();
    expect(deps.register).toHaveBeenCalledTimes(1);
    expect(deps.unregister).toHaveBeenCalledWith('dev_1');
  });

  it('clears the native account before unregister, even offline, and retries pending cleanup on sign-in', async () => {
    const { deps, registration } = setup();
    let pending: string | null = null;
    deps.getPendingDeviceId.mockImplementation(() => Promise.resolve(pending));
    deps.setPendingDeviceId.mockImplementation((id) => {
      pending = id;
      return Promise.resolve();
    });
    await registration.signedIn('user-1');
    expect(deps.setRingAccount).toHaveBeenCalledWith(userRef('user-1'));
    deps.unregister.mockRejectedValueOnce(new Error('offline'));
    const signOut = registration.signedOut();
    expect(deps.setRingAccount).toHaveBeenLastCalledWith(null);
    expect(deps.unregister).toHaveBeenCalledTimes(0);
    await signOut;
    expect(pending).toBe('dev_1');
    expect(deps.deleteToken).toHaveBeenCalledOnce();
    deps.getToken.mockResolvedValue('tok_2');
    await registration.signedIn('user-2');
    expect(deps.setRingAccount).toHaveBeenLastCalledWith(userRef('user-2'));
    expect(deps.unregister).toHaveBeenCalledTimes(2);
    expect(pending).toBeNull();
    expect(deps.register).toHaveBeenLastCalledWith(
      'dev_1',
      expect.objectContaining({ fcm_token: 'tok_2' }),
    );
  });

  it('does nothing without Firebase, and a failed register is retried next time', async () => {
    const none = setup(null);
    await none.registration.signedIn('user-1');
    expect(none.deps.register).not.toHaveBeenCalled();

    const { deps, registration } = setup();
    deps.register.mockRejectedValueOnce(new Error('offline'));
    await registration.signedIn('user-1');
    expect(registration.registered).toBeUndefined();
    await registration.signedIn('user-1');
    expect(deps.register).toHaveBeenCalledTimes(2);
    expect(registration.registered).toBe('tok_1');
  });

  it('still tries to unregister when the register never succeeded', async () => {
    const { deps, registration } = setup();
    deps.register.mockRejectedValue(new Error('offline'));
    await registration.signedIn('user-1');
    await registration.signedOut();
    expect(deps.unregister).toHaveBeenCalledWith('dev_1');
  });
});

describe('history', () => {
  const now = new Date('2026-09-30T10:30:00.000Z');
  const missed = {
    call_id: `inv_${'a'.repeat(26)}`,
    kind: 'missed_invite' as const,
    agent_id: `agt_${'b'.repeat(20)}`,
    agent_name: 'Claude',
    reason: 'Deploy is blocked on your approval for the production release today',
    started_at: '2026-09-30T10:25:00.000Z',
    duration_s: 0,
    outcome: 'missed' as const,
  };

  it('renders a missed invite as a missed call with the reason', () => {
    const row = missedCallRow(missed, now);
    expect(row.line).toBe(
      'Missed call · Claude: Deploy is blocked on your approval for the produ…',
    );
    expect(row.when).toBe('5 min ago');
    expect(row.key).toBe(`invite:inv_${'a'.repeat(26)}`);
    expect(row.agentId).toBe(`agt_${'b'.repeat(20)}`);
    expect(row.accessibilityLabel).toContain('Missed call from Claude, 5 min ago.');
    expect(missedCallRow({ ...missed, reason: '' }, now).line).toBe('Missed call · Claude');
  });

  it('keeps ordinary calls as they were', () => {
    const row = historyListRow(
      {
        call_id: `call_${'a'.repeat(20)}`,
        agent_id: `agt_${'b'.repeat(20)}`,
        agent_name: 'Claude',
        started_at: '2026-09-30T10:00:00.000Z',
        duration_s: 65,
        outcome: 'completed',
        end_reason: 'hangup',
      },
      now,
    );
    expect(row.kind).toBe('call');
    expect(historyListRow(missed, now).kind).toBe('missed');
  });
});

describe('ring settings', () => {
  it('maps server settings to the form and back', () => {
    const form = formFromSettings({ dnd: false, quiet_hours: null });
    expect(form).toEqual({
      dnd: false,
      quietEnabled: false,
      start: '22:00',
      end: '07:00',
      afterCallResult: 'ring',
    });
    // Never set: stays null.
    expect(settingsFromForm({ ...form, dnd: true }, 'Asia/Kolkata')).toEqual({
      ok: true,
      settings: { dnd: true, quiet_hours: null },
    });
    expect(settingsFromForm({ ...form, quietEnabled: true, start: '7:5' }, 'UTC')).toEqual({
      ok: false,
      field: 'start',
    });
    expect(
      settingsFromForm({ ...form, quietEnabled: true, start: '2330', end: '6:00' }, 'UTC'),
    ).toEqual({
      ok: true,
      settings: {
        dnd: false,
        quiet_hours: { enabled: true, start: '23:30', end: '06:00', tz: 'UTC' },
      },
    });
  });

  it('keeps the times when quiet hours are switched off', () => {
    const previous = {
      dnd: false,
      quiet_hours: { enabled: true, start: '23:00', end: '06:30', tz: 'UTC' },
    };
    const form = { ...formFromSettings(previous), quietEnabled: false };
    expect(settingsFromForm(form, 'Asia/Kolkata', previous)).toEqual({
      ok: true,
      settings: {
        dnd: false,
        quiet_hours: { enabled: false, start: '23:00', end: '06:30', tz: 'Asia/Kolkata' },
      },
    });
  });

  it('maps the after-call row and saves it alongside DND and quiet hours only when chats exist', () => {
    const previous = {
      dnd: true,
      after_call_result: 'ring' as const,
      quiet_hours: { enabled: true, start: '23:00', end: '06:30', tz: 'UTC' },
    };
    const form = { ...formFromSettings(previous), afterCallResult: 'message' as const };
    expect(settingsFromForm(form, 'UTC', previous, true)).toEqual({
      ok: true,
      settings: { ...previous, after_call_result: 'message' },
    });
    expect(settingsFromForm(form, 'UTC', previous, false)).toEqual({
      ok: true,
      settings: previous,
    });
    expect(formFromSettings(previous).afterCallResult).toBe('ring');
  });

  it('restores the old after-call value after a failed save', async () => {
    const previous = { dnd: true, quiet_hours: null, after_call_result: 'ring' as const };
    const request = { ...previous, after_call_result: 'message' as const };
    const failure = new Error('offline');
    const result = await persistRingSettings(request, previous, () => Promise.reject(failure));
    expect(result).toEqual({ ok: false, error: failure, form: formFromSettings(previous) });
  });

  it('normalizes clock times and summarizes', () => {
    expect(normalizeClock('7:05')).toBe('07:05');
    expect(normalizeClock('24:00')).toBeUndefined();
    expect(normalizeClock('12:60')).toBeUndefined();
    expect(normalizeClock('noon')).toBeUndefined();
    expect(ringSummary({ dnd: true, quiet_hours: null })).toMatch(/Do not disturb/);
    expect(
      ringSummary({
        dnd: false,
        quiet_hours: { enabled: true, start: '22:00', end: '07:00', tz: 'UTC' },
      }),
    ).toBe('Quiet from 22:00 to 07:00.');
  });
});
