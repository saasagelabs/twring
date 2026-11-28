import {
  MAX_CALL_TRANSCRIPT_CHARS,
  MAX_CALL_TRANSCRIPT_LINES,
  callTranscriptSchema,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { CallTranscriptBuffer } from './transcript';

describe('CallTranscriptBuffer', () => {
  it('keeps lines in order, strips controls, skips empty lines', () => {
    const buffer = new CallTranscriptBuffer();
    expect(buffer.transcript()).toBeUndefined();
    buffer.add('you', 'hel\u0007lo ');
    buffer.add('agent', '   ');
    buffer.add('agent', 'hi', true);
    expect(buffer.transcript()).toEqual({
      lines: [
        { who: 'you', text: 'hello' },
        { who: 'agent', text: 'hi', cut: true },
      ],
    });
  });

  it('stops at the line cap and says it was truncated', () => {
    const buffer = new CallTranscriptBuffer();
    for (let i = 0; i <= MAX_CALL_TRANSCRIPT_LINES; i += 1) buffer.add('you', `line ${i}`);
    const transcript = buffer.transcript()!;
    expect(transcript.lines).toHaveLength(MAX_CALL_TRANSCRIPT_LINES);
    expect(transcript.truncated).toBe(true);
    expect(callTranscriptSchema.safeParse(transcript).success).toBe(true);
  });

  it('stops at the character cap, never on half a surrogate pair', () => {
    const buffer = new CallTranscriptBuffer();
    buffer.add('agent', 'a'.repeat(MAX_CALL_TRANSCRIPT_CHARS - 1));
    buffer.add('you', '\u{1F600}more');
    buffer.add('you', 'ignored');
    const transcript = buffer.transcript()!;
    expect(transcript.lines).toHaveLength(1);
    expect(transcript.truncated).toBe(true);
    expect(callTranscriptSchema.safeParse(transcript).success).toBe(true);
  });

  it('replace keeps the total within the cap', () => {
    const buffer = new CallTranscriptBuffer();
    const index = buffer.add('you', 'short')!;
    buffer.add('agent', 'b'.repeat(MAX_CALL_TRANSCRIPT_CHARS - 10));
    buffer.replace(index, 'c'.repeat(50));
    const transcript = buffer.transcript()!;
    expect(transcript.lines[0]!.text).toBe('c'.repeat(10));
    expect(transcript.truncated).toBe(true);
    expect(callTranscriptSchema.safeParse(transcript).success).toBe(true);
  });
});
