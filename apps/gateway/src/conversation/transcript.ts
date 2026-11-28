import {
  MAX_CALL_TRANSCRIPT_CHARS,
  MAX_CALL_TRANSCRIPT_LINES,
  type CallTranscript,
  type CallTranscriptLine,
} from '@twring/contracts';

/** C0 controls other than tab and newline, and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
/** Half a surrogate pair on its own. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `text` without controls or lone surrogates, trimmed. */
export function cleanTranscriptText(text: string): string {
  return text.replace(CONTROL_CHARS, '').replace(LONE_SURROGATE, '�').trim();
}

/** The first `max` UTF-16 units of `text`, never ending on half a surrogate pair. */
function keepStart(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * What was said on a call, in order (ADR-050): the caller's committed turns and what the agent said
 * aloud. Twring's own lines never go in. Bounded by MAX_CALL_TRANSCRIPT_CHARS and _LINES: past
 * either, nothing more is added and the transcript is marked truncated. Memory only.
 */
export class CallTranscriptBuffer {
  private readonly lines: CallTranscriptLine[] = [];
  private chars = 0;
  private truncated = false;

  /** Adds a line; returns its index, or undefined when it was empty or did not fit. */
  add(who: CallTranscriptLine['who'], text: string, cut = false): number | undefined {
    const clean = cleanTranscriptText(text);
    if (clean === '' || this.truncated) return undefined;
    if (this.lines.length >= MAX_CALL_TRANSCRIPT_LINES) {
      this.truncated = true;
      return undefined;
    }
    const room = MAX_CALL_TRANSCRIPT_CHARS - this.chars;
    const kept = keepStart(clean, room);
    if (kept.length < clean.length) this.truncated = true;
    if (kept === '') return undefined;
    this.lines.push({ who, text: kept, ...(cut && { cut: true }) });
    this.chars += kept.length;
    return this.lines.length - 1;
  }

  /**
   * Replaces the text of line `index` (a merged turn replaces the line of the turn it took in);
   * cut to what still fits.
   */
  replace(index: number, text: string): void {
    const line = this.lines[index];
    if (line === undefined) return;
    const clean = cleanTranscriptText(text);
    if (clean === '') return;
    const room = MAX_CALL_TRANSCRIPT_CHARS - (this.chars - line.text.length);
    const kept = keepStart(clean, room);
    if (kept.length < clean.length) this.truncated = true;
    if (kept === '') return;
    this.chars += kept.length - line.text.length;
    line.text = kept;
  }

  /** Undefined when nothing was said. */
  transcript(): CallTranscript | undefined {
    if (this.lines.length === 0) return undefined;
    return {
      lines: this.lines.map((line) => ({ ...line })),
      ...(this.truncated && { truncated: true }),
    };
  }
}
