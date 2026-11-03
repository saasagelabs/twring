/**
 * Residual-echo rejection (ADR-015). On a loud speakerphone the phone's hardware AEC leaves enough
 * of the agent's own voice in the caller's audio for STT to transcribe it. The gateway knows what
 * the agent said and how much of it has played, so a transcript made of the words audible right
 * now (a window around the playout position) is treated as echo. Words not yet played, or played
 * long ago, never are.
 */

/** Echo window reaches this far back from the playout position. */
export const ECHO_LOOKBACK_MS = 4000;
/** …and this far ahead of it (jitter buffers, the phone's own playout delay). */
export const ECHO_LOOKAHEAD_MS = 1000;
/** A cut generation stays audible (as echo) this long after the cut. */
export const ECHO_TAIL_MS = 1000;
/**
 * A generation that played out in full stays audible this long after its last frame: short, so a
 * prompt answer to its closing question is the caller's.
 */
export const ECHO_FINISHED_TAIL_MS = 500;
/** Speaking rate assumed until TTS reports a generation's total audio length. */
export const DEFAULT_SPEECH_CHARS_PER_S = 14;
/** The window widens by this share of the playout position to absorb speaking-rate error. */
export const ECHO_RATE_SLACK = 0.15;
/** …but by at most this much audio, so late in a long answer the window stays narrow. */
export const ECHO_MAX_SLACK_MS = 2000;
/** Tails this long or longer must also match the agent's word order (word pairs). */
export const ECHO_BIGRAM_MIN_WORDS = 3;
/** …with at least this share of their word pairs in the window. */
export const ECHO_BIGRAM_RATIO = 0.6;
/** Words of the window STT may drop between two matched words of an echo run. */
const ECHO_MAX_SKIP = 2;

const UNITS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
]; // prettier-ignore
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const CONTRACTIONS: Readonly<Record<string, string>> = {
  "it's": 'it is',
  "that's": 'that is',
  "don't": 'do not',
  "doesn't": 'does not',
  "isn't": 'is not',
  "i'm": 'i am',
  "you're": 'you are',
  "we're": 'we are',
  "can't": 'can not',
  cannot: 'can not',
  "won't": 'will not',
};

function numberWords(digits: string): string[] {
  const n = Number(digits);
  if (digits.length > 2) return [digits];
  if (n < 20) return [UNITS[n]!];
  const tens = TENS[Math.floor(n / 10)]!;
  return n % 10 === 0 ? [tens] : [tens, UNITS[n % 10]!];
}

function normalizeToken(token: string): string[] {
  if (token.includes('-')) {
    const parts = token.split('-');
    // "e-mail" is written "email" by STT; "follow-up" is "follow up".
    // "3-5" is spoken "three to five".
    if (parts.length === 2 && parts.every((p) => /^[0-9]+$/.test(p)))
      return [...normalizeToken(parts[0]!), 'to', ...normalizeToken(parts[1]!)];
    if (parts.some((p) => /^\p{L}$/u.test(p))) return normalizeToken(parts.join(''));
    return parts.flatMap(normalizeToken);
  }
  const expanded = CONTRACTIONS[token];
  if (expanded !== undefined) return expanded.split(' ');
  const word = token.replace(/'/g, '');
  if (word === 'ok') return ['okay'];
  const out: string[] = [];
  for (const run of word.matchAll(/\p{N}+|\p{L}+/gu)) {
    out.push(...(/^[0-9]+$/.test(run[0]) ? numberWords(run[0]) : [run[0]]));
  }
  return out;
}

/**
 * Words of `text` in one canonical spoken form, so TTS input and STT output compare: lowercase,
 * apostrophes unified, 0–99 as words, ok/okay, a.m./p.m., % as "percent", hyphen variants, common
 * contractions expanded.
 */
export function echoWords(text: string): string[] {
  const s = text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\b([ap])\.\s?m\b\.?/g, '$1m')
    .replace(/%/g, ' percent ');
  const words: string[] = [];
  for (const match of s.matchAll(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu)) {
    words.push(...normalizeToken(match[0]));
  }
  return words;
}

/** Character offsets [start, end) of a generation's text. */
export interface TextSpan {
  start: number;
  end: number;
}

/**
 * The span of a generation's text audible now: `playedMs` of its audio has played (Infinity once
 * it played out in full), the whole generation is `totalAudioMs` long once TTS has said so.
 * Expanded to whole words. A played-out generation is judged at its end, looking back only.
 */
export function audibleSpan(text: string, playedMs: number, totalAudioMs?: number): TextSpan {
  if (text === '') return { start: 0, end: 0 };
  const perMs =
    totalAudioMs !== undefined && totalAudioMs > 0
      ? text.length / totalAudioMs
      : DEFAULT_SPEECH_CHARS_PER_S / 1000;
  const finished = playedMs === Number.POSITIVE_INFINITY;
  const position = Math.min(text.length, playedMs * perMs);
  const slack = finished ? 0 : Math.min(position * ECHO_RATE_SLACK, ECHO_MAX_SLACK_MS * perMs);
  let start = Math.max(0, Math.floor(position - ECHO_LOOKBACK_MS * perMs - slack));
  let end = Math.min(text.length, Math.ceil(position + ECHO_LOOKAHEAD_MS * perMs + slack));
  const inWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}'’-]/u.test(c);
  while (start > 0 && inWord(text[start - 1])) start -= 1;
  while (end < text.length && inWord(text[end])) end += 1;
  return { start, end };
}

/** The text of `audibleSpan`. */
export function audibleText(text: string, playedMs: number, totalAudioMs?: number): string {
  const { start, end } = audibleSpan(text, playedMs, totalAudioMs);
  return text.slice(start, end);
}

/** What the agent is audibly saying: word sets plus ordered runs (one per stretch of speech). */
export interface EchoWindow {
  words: Set<string>;
  bigrams: Set<string>;
  runs: string[][];
}

export function echoWindow(texts: readonly string[] = []): EchoWindow {
  const window: EchoWindow = { words: new Set(), bigrams: new Set(), runs: [] };
  for (const text of texts) addToWindow(window, echoWords(text));
  return window;
}

function addToWindow(window: EchoWindow, run: string[]): void {
  if (run.length === 0) return;
  window.runs.push(run);
  run.forEach((word, i) => {
    window.words.add(word);
    if (i > 0) window.bigrams.add(`${run[i - 1]} ${word}`);
  });
}

/**
 * Words of `next` that are new since `prev` (Flux partials are cumulative). A partial that is not
 * an extension of the previous one is new as a whole.
 */
export function newWords(prev: readonly string[] | undefined, next: readonly string[]): string[] {
  if (prev === undefined || prev.length > next.length) return [...next];
  for (let i = 0; i < prev.length; i += 1) if (prev[i] !== next[i]) return [...next];
  return next.slice(prev.length);
}

export interface EchoVerdict {
  echo: boolean;
  /** Words judged. */
  words: number;
  /** Share of those words (short) or word pairs (longer) in the window, 0–1. */
  overlap: number;
}

/** A partial's new words are echo iff all are in the window and, 3+ words, 60% of their pairs. */
export function judgeTail(words: readonly string[], window: EchoWindow): EchoVerdict {
  const n = words.length;
  if (n === 0) return { echo: true, words: 0, overlap: 1 };
  const known = words.filter((w) => window.words.has(w)).length;
  if (known < n || n < ECHO_BIGRAM_MIN_WORDS)
    return { echo: known === n, words: n, overlap: known / n };
  let pairs = 0;
  for (let i = 1; i < n; i += 1) if (window.bigrams.has(`${words[i - 1]} ${words[i]}`)) pairs += 1;
  const overlap = pairs / (n - 1);
  return { echo: overlap >= ECHO_BIGRAM_RATIO, words: n, overlap };
}

/**
 * How many leading words of `words` follow one of the window's runs in order (STT may drop up to
 * two of the agent's words between them). A commit is echo when this is all of it.
 */
export function echoPrefixLength(words: readonly string[], window: EchoWindow): number {
  let best = 0;
  for (const run of window.runs) {
    for (let s = 0; s < run.length && best < words.length; s += 1) {
      if (run[s] !== words[0]) continue;
      let i = 1;
      let j = s + 1;
      while (i < words.length) {
        let found = -1;
        for (let k = j; k < run.length && k <= j + ECHO_MAX_SKIP; k += 1) {
          if (run[k] === words[i]) {
            found = k;
            break;
          }
        }
        if (found < 0) break;
        i += 1;
        j = found + 1;
      }
      best = Math.max(best, i);
    }
  }
  return best;
}

/** Whole-transcript convenience: judged as one tail. */
export function isEcho(text: string, window: EchoWindow): boolean {
  return judgeTail(echoWords(text), window).echo;
}
