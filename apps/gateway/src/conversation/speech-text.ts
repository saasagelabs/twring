/** A single "word" longer than this is released even without a following space. */
const MAX_HELD_CHARS = 300;
/** An unclosed `[` or `<` is held at most this long, so a stray one can't cause long dead air. */
const MAX_LINK_HOLD_CHARS = 120;

const AUTOLINK = /<https?:\/\/[^\s>]*>/gi;
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const URL = /\bhttps?:\/\/[^\s<>"'()[\]]*[^\s<>"'()[\].,;:!?]/g;
const TAG = /<\/?[a-z][^>]*>/gi;
const MARKS = /[*`~|]/g;
const UNDERSCORE_MARK = /(?<!\w)_+|_+(?!\w)/g;
const LINE_PREFIX = /^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+)/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;
/** A complete link, or complete brackets that aren't a link, at the start of the text. */
const LINK_START = /^!?\[[^\]]*\]\([^)]*\)|^\[[^\]]*\](?=[^(])/;
/** A complete HTML tag or autolink at the start of the text. */
const TAG_START = /^<\/?[a-z][^>]*>/i;
/** What could still become a tag or autolink once more text arrives. */
const TAG_PREFIX = /^<\/?(?:[a-z][^>]*)?$/i;

/**
 * Turns streamed agent text into text fit to speak (VOICE_ARCHITECTURE §9). Flux TTS takes a turn's
 * text as a stream and chooses its own synthesis boundaries (ADR-013/014), so this doesn't split
 * sentences. It releases whole words only, holds back a link or tag until it is complete, and drops
 * what shouldn't be read aloud: markdown syntax, code blocks, raw URLs, and HTML tags. The visible
 * transcript keeps the agent's original text.
 */
export class SpeechTextFilter {
  private buffer = '';
  private atLineStart = true;
  private inFence = false;
  private lastSpoken = '';
  /** The previous delta ended in `\r`, so a `\n` opening this one completes that CRLF. */
  private pendingCR = false;

  /** Adds agent text; returns what can be spoken now (possibly empty). */
  push(delta: string): string {
    let text = delta;
    if (this.pendingCR && text.startsWith('\n')) text = text.slice(1);
    if (delta !== '') this.pendingCR = delta.endsWith('\r');
    this.buffer += text.replace(/\r\n?/g, '\n');
    const cut = this.safeCut();
    if (cut === 0) return '';
    const ready = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return this.convert(ready);
  }

  /** The agent finished: returns whatever is left. */
  end(): string {
    const rest = this.buffer;
    this.buffer = '';
    return this.convert(rest);
  }

  /** Index up to which the buffer can be released: after the last whitespace, before an open link or tag. */
  private safeCut(): number {
    const buffer = this.buffer;
    let cut =
      Math.max(buffer.lastIndexOf(' '), buffer.lastIndexOf('\n'), buffer.lastIndexOf('\t')) + 1;
    if (cut === 0 && buffer.length > MAX_HELD_CHARS) return buffer.length;
    const open = buffer.lastIndexOf('[', cut - 1);
    if (open >= 0) {
      const link = LINK_START.exec(buffer.slice(open));
      // Hold an unfinished link (bounded), or a finished one the cut would split.
      if (link ? open + link[0].length > cut : buffer.length - open <= MAX_LINK_HOLD_CHARS)
        cut = open > 0 && buffer[open - 1] === '!' ? open - 1 : open;
    }
    const lt = buffer.lastIndexOf('<', cut - 1);
    if (lt >= 0) {
      const tail = buffer.slice(lt);
      const tag = TAG_START.exec(tail);
      // Same for a tag or autolink; a `<` that can't start one (like "a < b") isn't held.
      const hold = tag
        ? lt + tag[0].length > cut
        : TAG_PREFIX.test(tail) && tail.length <= MAX_LINK_HOLD_CHARS;
      if (hold) cut = Math.min(cut, lt);
    }
    return cut;
  }

  private convert(raw: string): string {
    let out = '';
    for (const piece of raw.split(/(\n)/)) {
      if (piece === '\n') {
        if (!this.inFence) out += this.lineBreak(out);
        this.atLineStart = true;
        continue;
      }
      if (piece === '') continue;
      let line = piece;
      if (this.atLineStart) {
        if (FENCE.test(line)) {
          this.inFence = !this.inFence;
          this.atLineStart = false;
          continue;
        }
        line = line.replace(LINE_PREFIX, '');
      }
      this.atLineStart = false;
      if (this.inFence) continue;
      // Autolinks before tags (they look alike); tags before URLs so an href leaves with its tag.
      out += line
        .replace(AUTOLINK, 'link')
        .replace(LINK, '$1')
        .replace(TAG, '')
        .replace(URL, 'link')
        .replace(MARKS, '')
        .replace(UNDERSCORE_MARK, '');
    }
    out = out.replace(/[ \t]{2,}/g, ' ');
    // No leading space at the start of speech or right after one already sent.
    if (this.lastSpoken === '' || /\s$/.test(this.lastSpoken)) out = out.replace(/^\s+/, '');
    if (out !== '') this.lastSpoken = out;
    return out;
  }

  /** A line break becomes a pause: a period after a bare word (list items, headings), else a space. */
  private lineBreak(sofar: string): string {
    const before = (sofar === '' ? this.lastSpoken : sofar).trimEnd();
    if (before === '') return '';
    return /[\p{L}\p{N}]$/u.test(before) ? '. ' : ' ';
  }
}
