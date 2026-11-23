/** A single "word" longer than this is released even without a following space. */
const MAX_HELD_CHARS = 300;
/** An unclosed `[` or `<` is held at most this long, so a stray one can't cause long dead air. */
const MAX_LINK_HOLD_CHARS = 120;
/** An unclosed inline code span is held at most this long (as for links: no long dead air). */
const MAX_CODE_HOLD_CHARS = MAX_LINK_HOLD_CHARS;
/** Inline code longer than this is dropped; shorter (like `npm test`) is read as words. */
const MAX_SPOKEN_CODE_CHARS = 40;

const AUTOLINK = /<https?:\/\/[^\s>]*>/gi;
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const URL = /\bhttps?:\/\/[^\s<>"'()[\]]*[^\s<>"'()[\].,;:!?]/g;
const TAG = /<\/?[a-z][^>]*>/gi;
const MARKS = /[*`~|]/g;
const UNDERSCORE_MARK = /(?<!\w)_+|_+(?!\w)/g;
const LINE_PREFIX = /^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+)/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;
const INLINE_CODE = /`([^`\n]*)`/g;
/**
 * A token with two or more slashes or backslashes: a file path. Matches start only at a token's
 * start (lookbehind), so a long run without spaces is scanned once, not once per character.
 */
const PATH = /(?<!\S)[^\s/\\]*(?:[/\\][^\s/\\]*){2,}/g;
/** A UUID, or a run of 12+ hex digits (a hash, a git sha); whole tokens only, like PATH. */
const HEX = /(?<![\w-])(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{12,})(?![\w-])/gi;
/**
 * Emoji and pictographs, with the parts that build them: skin tones, flag letters and tag
 * characters, keycap marks, joiners and variation selectors (after livekit/agents `filter_emoji`).
 */
const EMOJI =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{E0020}-\u{E007F}‍︎️⃣]/gu;
/** A CJK sentence end with any closing quotes: speech is released after it, as after a space. */
const CJK_END = /[。！？．][」』）”]*/g;
/** A thematic break (---, ***, ___), a setext underline (===) or a table's |---|:--:| row. */
const SEPARATOR = /^[ \t]*(?:([-*_=])(?:[ \t]*\1){2,}|(?=[^|]*\|)(?=[^-]*-)[|:\- \t]+)[ \t]*$/;
/** A markdown table row: read as its cells ("Free, 0"), without pipes. */
const TABLE_ROW = /^[ \t]{0,3}\|/;
/** An unfinished line that could still be a table row or a separator: held until it ends. */
const HELD_LINE = /^[ \t]{0,3}(?:\||[-*_=][-*_= \t]*$)/;
/** A complete link, or complete brackets that aren't a link, at the start of the text. */
const LINK_START = /^!?\[[^\]]*\]\([^)]*\)|^\[[^\]]*\](?=[^(])/;
/** A complete HTML tag or autolink at the start of the text. */
const TAG_START = /^<\/?[a-z][^>]*>/i;
/** What could still become a tag or autolink once more text arrives. */
const TAG_PREFIX = /^<\/?(?:[a-z][^>]*)?$/i;

/**
 * Turns streamed agent text into text fit to speak (VOICE_ARCHITECTURE §9). Flux TTS takes a turn's
 * text as a stream and chooses its own synthesis boundaries (ADR-013/014), so this doesn't split
 * sentences. It releases whole words only (or up to a CJK sentence end, since those languages use
 * no spaces), holds back a link, tag, table row or separator line until it is complete, and drops
 * what shouldn't be read aloud: markdown syntax, code blocks, raw URLs, HTML tags, emoji and
 * separator lines. A table is read row by row as plain cells ("Free, 0"). The visible
 * transcript keeps the agent's original text.
 */
export class SpeechTextFilter {
  private buffer = '';
  /** Said once, in place of the first code block the reply leaves out. */
  private codeNote: string | undefined;
  private atLineStart = true;
  private inFence = false;
  private lastSpoken = '';
  /** The previous delta ended in `\r`, so a `\n` opening this one completes that CRLF. */
  private pendingCR = false;

  /**
   * `codeNote` is said in place of the reply's first code block (once per reply), so the caller
   * knows to look at the screen and a reply of only code is not silence.
   */
  constructor(options: { codeNote?: string } = {}) {
    this.codeNote = options.codeNote;
  }

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
    // Japanese and Chinese have no spaces: a sentence end is the place to release.
    for (const end of buffer.matchAll(CJK_END)) cut = Math.max(cut, end.index + end[0].length);
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
    return this.holdOpenLine(this.holdOpenCode(cut));
  }

  /** Holds back an unfinished last line that may be a table row or separator (bounded). */
  private holdOpenLine(cut: number): number {
    const buffer = this.buffer;
    const lineStart = buffer.lastIndexOf('\n') + 1;
    if (lineStart === 0 && !this.atLineStart) return cut;
    const line = buffer.slice(lineStart);
    if (line.length > MAX_HELD_CHARS || !HELD_LINE.test(line)) return cut;
    return Math.min(cut, lineStart);
  }

  /** Holds back an inline code span still open on the last line before `cut` (bounded). */
  private holdOpenCode(cut: number): number {
    const buffer = this.buffer;
    const lineStart = buffer.lastIndexOf('\n', cut - 1) + 1;
    const line = buffer.slice(lineStart, cut);
    if ((lineStart > 0 || this.atLineStart) && FENCE.test(line)) return cut;
    let ticks = 0;
    let open = -1;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] !== '`') continue;
      ticks += 1;
      open = i;
    }
    if (ticks % 2 === 0) return cut;
    const at = lineStart + open;
    return buffer.length - at <= MAX_CODE_HOLD_CHARS ? at : cut;
  }

  private convert(raw: string): string {
    let out = '';
    for (const piece of raw.split(/(\n)/)) {
      if (piece === '\n') {
        if (!this.inFence) {
          const pause = this.lineBreak(out);
          // A dropped emoji or trailing space must not leave "word ." before the pause.
          out = pause === '. ' ? out.trimEnd() + pause : out + pause;
        }
        this.atLineStart = true;
        continue;
      }
      if (piece === '') continue;
      let line = piece;
      if (this.atLineStart) {
        if (FENCE.test(line)) {
          this.inFence = !this.inFence;
          this.atLineStart = false;
          if (this.inFence && this.codeNote !== undefined) {
            out = this.withNote(out, this.codeNote);
            this.codeNote = undefined;
          }
          continue;
        }
        if (!this.inFence && SEPARATOR.test(line)) {
          this.atLineStart = false;
          continue;
        }
        if (!this.inFence && TABLE_ROW.test(line))
          line = line
            .split('|')
            .map((cell) => cell.trim())
            .filter((cell) => cell !== '')
            .join(', ');
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
        .replace(INLINE_CODE, (_, code: string) =>
          code.length > MAX_SPOKEN_CODE_CHARS ? '' : code,
        )
        .replace(PATH, fileName)
        .replace(HEX, hexToken)
        .replace(EMOJI, '')
        .replace(MARKS, '')
        .replace(UNDERSCORE_MARK, '');
    }
    out = out.replace(/[ \t]{2,}/g, ' ');
    // No leading space at the start of speech or right after one already sent.
    if (this.lastSpoken === '' || /\s$/.test(this.lastSpoken)) out = out.replace(/^\s+/, '');
    if (out !== '') this.lastSpoken = out;
    return out;
  }

  /** `out` with `note` added as its own sentence. */
  private withNote(out: string, note: string): string {
    const before = (out.trim() === '' ? this.lastSpoken : out).trimEnd();
    const stop = /[\p{L}\p{N}]$/u.test(before) ? '.' : '';
    if (out.trim() !== '') return `${out.trimEnd()}${stop} ${note} `;
    // Nothing yet in this chunk: what was already sent may need a full stop before the note.
    return /\s$/.test(this.lastSpoken) || before === '' ? `${note} ` : `${stop} ${note} `;
  }

  /** A line break becomes a pause: a period after a bare word (list items, headings), else a space. */
  private lineBreak(sofar: string): string {
    const before = (sofar === '' ? this.lastSpoken : sofar).trimEnd();
    if (before === '') return '';
    return /[\p{L}\p{N}]$/u.test(before) ? '. ' : ' ';
  }
}

/**
 * A path is read as its file name ("src/app/call.tsx" says "call.tsx"): enough to tell which file,
 * the way a person names one aloud. Slashes between numbers only (a date) are left alone.
 */
function fileName(token: string): string {
  if (!/\p{L}/u.test(token)) return token;
  return (
    token
      .split(/[/\\]/)
      .filter((part) => part !== '')
      .at(-1) ?? ''
  );
}

/** A hash or id says nothing aloud; digits alone (a long number) are kept. */
function hexToken(token: string): string {
  return token.includes('-') || (/\d/.test(token) && /[a-f]/i.test(token)) ? '' : token;
}
