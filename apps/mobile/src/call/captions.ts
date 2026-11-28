/** Most of the agent's reply the call screen lays out; earlier words have rolled off the top. */
export const REPLY_TAIL_CHARS = 600;
/** Most of what the caller said that the call screen lays out. */
export const CAPTION_TAIL_CHARS = 300;

/**
 * The last `max` characters of `text`, starting on a word, with a leading `…` when cut. Bounds
 * layout work on a long answer; the band only shows its last lines anyway.
 */
export function captionTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const from = text.length - max;
  const space = text.indexOf(' ', from);
  const rest = space === -1 || space + 1 >= text.length ? text.slice(from) : text.slice(space + 1);
  return rest.startsWith('…') ? rest : `…${rest}`;
}

const SENTENCE_END = /[.!?…]/;

/**
 * What a screen reader is given for the agent's reply. It changes only when a sentence ends, or
 * when the reply is final, so streaming words are not read again one by one: while the agent
 * speaks it is the last finished sentence ('' before the first one ends).
 */
export function readableReply(text: string, final: boolean): string {
  const trimmed = text.trim();
  if (final) return trimmed;
  // A leading `…` only says the start was clipped; it ends no sentence.
  const clipped = trimmed.startsWith('…');
  const body = trimmed.replace(/^…+/, '');
  let end = -1;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    if (!SENTENCE_END.test(body[index] ?? '')) continue;
    const next = body[index + 1];
    // "3.5" or "e.g." mid-word is not a sentence end; the end of the text or a space is.
    if (next === undefined || /\s/.test(next)) {
      end = index;
      break;
    }
  }
  if (end === -1) return '';
  let start = -1;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (SENTENCE_END.test(body[index] ?? '') && /\s/.test(body[index + 1] ?? '')) {
      start = index;
      break;
    }
  }
  // Clipped with one sentence end: what comes before it is the tail of a cut sentence.
  if (start === -1 && clipped) return '';
  return body.slice(start + 1, end + 1).trim();
}
