import { describe, expect, it } from 'vitest';

import { CALL_TRANSCRIPT_HOLD_MS, sendCallTranscriptResponseSchema } from './calls';
import { DEFAULT_RING_SETTINGS, ringSettingsSchema } from './ring';
import {
  MAX_CALL_TRANSCRIPT_CHARS,
  MAX_CALL_TRANSCRIPT_LINES,
  callTranscriptSchema,
  threadMessageSchema,
} from './threads';

const callCard = {
  id: `msg_${'a'.repeat(20)}`,
  agent_id: `agt_${'a'.repeat(20)}`,
  seq: 1,
  rev: 1,
  created_at: '2026-11-28T10:00:00.000Z',
  updated_at: '2026-11-28T10:00:00.000Z',
  kind: 'call',
  call_id: 'call_aaaaaaaaaaaaaaaaaaaa',
  duration_s: 30,
  outcome: 'completed',
};

describe('call transcripts (ADR-050)', () => {
  it('accepts ordered lines, cut and truncated', () => {
    const transcript = {
      lines: [
        { who: 'you', text: 'hi' },
        { who: 'agent', text: 'hello', cut: true },
      ],
      truncated: true,
    };
    expect(callTranscriptSchema.parse(transcript)).toEqual(transcript);
  });

  it('refuses empty lines, no lines, other speakers, and too much', () => {
    expect(callTranscriptSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(callTranscriptSchema.safeParse({ lines: [{ who: 'you', text: '' }] }).success).toBe(
      false,
    );
    expect(callTranscriptSchema.safeParse({ lines: [{ who: 'twring', text: 'x' }] }).success).toBe(
      false,
    );
    const many = Array.from({ length: MAX_CALL_TRANSCRIPT_LINES + 1 }, () => ({
      who: 'you',
      text: 'x',
    }));
    expect(callTranscriptSchema.safeParse({ lines: many }).success).toBe(false);
    const half = 'a'.repeat(MAX_CALL_TRANSCRIPT_CHARS / 2);
    expect(
      callTranscriptSchema.safeParse({
        lines: [
          { who: 'you', text: half },
          { who: 'agent', text: `${half}a` },
        ],
      }).success,
    ).toBe(false);
  });

  it('a call card may carry a transcript, or not', () => {
    expect(threadMessageSchema.safeParse(callCard).success).toBe(true);
    const withTranscript = { ...callCard, transcript: { lines: [{ who: 'you', text: 'hi' }] } };
    expect(threadMessageSchema.parse(withTranscript)).toMatchObject(withTranscript);
  });

  it('ring settings: call_transcripts is optional and off by default', () => {
    expect(DEFAULT_RING_SETTINGS.call_transcripts).toBe(false);
    expect(ringSettingsSchema.safeParse({ dnd: false, quiet_hours: null }).success).toBe(true);
    expect(
      ringSettingsSchema.parse({ dnd: false, quiet_hours: null, call_transcripts: true })
        .call_transcripts,
    ).toBe(true);
  });

  it('send response and hold', () => {
    expect(sendCallTranscriptResponseSchema.parse({ sent: true })).toEqual({ sent: true });
    expect(sendCallTranscriptResponseSchema.safeParse({ sent: false }).success).toBe(false);
    expect(CALL_TRANSCRIPT_HOLD_MS).toBe(600_000);
  });
});
