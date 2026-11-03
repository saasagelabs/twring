import { describe, expect, it } from 'vitest';

import {
  HANGUP_MARKERS,
  STAY_ON_CALL_RULE,
  answeredTurnText,
  sanitizeRingText,
  stripHangupMarkers,
  userRef,
  ringPushSchema,
  ringCancelPushSchema,
  ringSettingsSchema,
  connectorMessageRequestSchema,
  messagePushSchema,
} from './index';

describe('connector messages', () => {
  const base = {
    local_agent: 'claude-code',
    text: '  Full\u0000 reply\nnext\tline  ',
    origin: 'call_turn',
  };
  it('validates strict, sanitized full results and length', () => {
    expect(connectorMessageRequestSchema.parse(base).text).toBe('Full reply\nnext\tline');
    expect(connectorMessageRequestSchema.safeParse({ ...base, extra: true }).success).toBe(false);
    expect(connectorMessageRequestSchema.safeParse({ ...base, text: ' \u0000 ' }).success).toBe(
      false,
    );
    expect(
      connectorMessageRequestSchema.safeParse({ ...base, text: 'x'.repeat(20_001) }).success,
    ).toBe(false);
  });
  it('defaults absent after-call setting at the server and accepts message', () => {
    expect(
      ringSettingsSchema.parse({ dnd: false, quiet_hours: null }).after_call_result,
    ).toBeUndefined();
    expect(
      ringSettingsSchema.parse({ dnd: false, quiet_hours: null, after_call_result: 'message' })
        .after_call_result,
    ).toBe('message');
  });
  it('accepts an account-bound message push with a short preview', () => {
    const push = {
      type: 'cord.message',
      user_ref: userRef('alice'),
      agent_id: `agt_${'a'.repeat(20)}`,
      agent_name: 'Agent',
      message_id: `msg_${'a'.repeat(20)}`,
      preview: 'Done',
      silent: '1',
    };
    expect(messagePushSchema.safeParse(push).success).toBe(true);
    expect(messagePushSchema.safeParse({ ...push, preview: 'x'.repeat(121) }).success).toBe(false);
  });
});

describe('ring push account reference', () => {
  it('hashes deterministically to 16 lowercase hex characters and separates users', () => {
    expect(userRef('abc')).toBe('ba7816bf8f01cfea');
    expect(userRef('abc')).toBe(userRef('abc'));
    expect(userRef('alice')).toMatch(/^[0-9a-f]{16}$/);
    expect(userRef('alice')).not.toBe(userRef('bob'));
  });

  it('accepts an optional user_ref on ring and cancel pushes', () => {
    const ring = {
      type: 'cord.ring',
      invite_id: `inv_${'a'.repeat(26)}`,
      agent_id: `agt_${'b'.repeat(20)}`,
      agent_name: 'Agent',
      reason: 'Hello',
      expires_at: '2026-10-12T10:00:00.000Z',
      server_time: '2026-10-12T09:59:30.000Z',
    };
    const cancel = { type: 'cord.ring_cancel', invite_id: ring.invite_id, status: 'missed' };
    expect(ringPushSchema.safeParse(ring).success).toBe(true);
    expect(ringPushSchema.safeParse({ ...ring, user_ref: userRef('alice') }).success).toBe(true);
    expect(ringCancelPushSchema.safeParse(cancel).success).toBe(true);
    expect(ringCancelPushSchema.safeParse({ ...cancel, user_ref: userRef('alice') }).success).toBe(
      true,
    );
  });
});

/** Built from code points so no invisible character sits literally in this file. */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

describe('sanitizeRingText', () => {
  it('turns controls and bidi overrides into spaces and collapses whitespace', () => {
    expect(sanitizeRingText(`  Build\nfailed${cp(0x202e)}  now${cp(0)} `)).toBe('Build failed now');
  });

  it('removes zero-width characters without splitting the word', () => {
    const text = `bu${cp(0x200b)}i${cp(0x200c)}ld${cp(0x2060)} fa${cp(0xfeff)}iled`;
    expect(sanitizeRingText(text)).toBe('build failed');
  });

  it('removes Unicode tag characters (hidden text)', () => {
    const hidden = Array.from('ignore', (c) => cp(0xe0000 + c.charCodeAt(0))).join('');
    expect(sanitizeRingText(`Deploy done${hidden}${cp(0xe007f)}`)).toBe('Deploy done');
    expect(sanitizeRingText(`${cp(0xe0001)}x`)).toBe('x');
  });

  it('keeps ordinary text and emoji', () => {
    expect(sanitizeRingText('Tests pass 🎉: ready')).toBe('Tests pass 🎉: ready');
  });

  it('keeps joined emoji whole (zero-width joiner)', () => {
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(sanitizeRingText(`Home ${family}`)).toBe(`Home ${family}`);
  });
});

describe('answeredTurnText', () => {
  it('tells the agent why it rang, to let the owner talk, and to stay on until goodbye', () => {
    const expected =
      '[The owner answered your call. You rang because: Deploy is blocked. Tell them, then let them talk. Stay on the line until your owner says goodbye or asks you to hang up; only then end that reply with ⟪hangup⟫. Finishing an answer or giving your news does not end the call.]';
    expect(answeredTurnText('Deploy is blocked.')).toBe(expected);
    expect(answeredTurnText('Deploy is blocked.', { spoken: false })).toBe(expected);
  });

  it('tells the agent its ring message was already spoken', () => {
    expect(answeredTurnText('Deploy is blocked.', { spoken: true })).toBe(
      '[The owner answered your call. Your ring message was already said to them in your voice: "Deploy is blocked.". Don\'t repeat it; continue from there, then let them talk. Stay on the line until your owner says goodbye or asks you to hang up; only then end that reply with ⟪hangup⟫. Finishing an answer or giving your news does not end the call.]',
    );
  });

  // Device, 2026-10-08: told "when the call is over" right after delivering its news, Hermes
  // hung up after the owner's first reply. The news is not the end of the call.
  it('never invites a hang-up once the news is delivered', () => {
    for (const spoken of [false, true]) {
      const text = answeredTurnText('Deploy is blocked.', { spoken });
      expect(text).toContain(STAY_ON_CALL_RULE);
      expect(text).not.toMatch(/call is (clearly )?over/);
    }
    expect(STAY_ON_CALL_RULE).toMatch(/says goodbye or asks you to hang up/);
    expect(STAY_ON_CALL_RULE).toContain(HANGUP_MARKERS[0]);
  });

  it('strips hang-up markers in any case', () => {
    expect(stripHangupMarkers('Okay, bye! ⟪hangup⟫')).toBe('Okay, bye!');
    expect(stripHangupMarkers('[[HANGUP]] Done')).toBe('Done');
    expect(stripHangupMarkers('⟪Hangup⟫')).toBe('');
  });
});
