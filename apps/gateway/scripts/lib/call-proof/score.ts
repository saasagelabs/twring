/**
 * Call proof scoring: what the gateway heard against what the caller said, per listening
 * condition, and the verdict against fixed thresholds and the stored baseline.
 *
 * Word error rate follows pipecat-ai/stt-benchmark's normalized WER (lowercase, punctuation
 * stripped, numbers in one spelling) without its LLM judge, so the score is deterministic.
 */

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0 to 999,999,999 in words, without "and" ("one hundred five"). */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e9) return String(n);
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 === 0 ? '' : ` ${ONES[n % 10]!}`);
  if (n < 1000) {
    const rest = n % 100;
    return `${ONES[Math.floor(n / 100)]!} hundred${rest === 0 ? '' : ` ${numberToWords(rest)}`}`;
  }
  const [unit, size] = n < 1e6 ? ['thousand', 1000] : ['million', 1e6];
  const rest = n % size;
  return `${numberToWords(Math.floor(n / size))} ${unit}${rest === 0 ? '' : ` ${numberToWords(rest)}`}`;
}

/** Ordinal words to cardinal words, so "the third" and "the 3rd" and "the 3" all match. */
const ORDINALS: Record<string, string> = {
  first: 'one',
  second: 'two',
  third: 'three',
  fourth: 'four',
  fifth: 'five',
  sixth: 'six',
  seventh: 'seven',
  eighth: 'eight',
  ninth: 'nine',
  tenth: 'ten',
  eleventh: 'eleven',
  twelfth: 'twelve',
  thirteenth: 'thirteen',
  fourteenth: 'fourteen',
  fifteenth: 'fifteen',
  sixteenth: 'sixteen',
  seventeenth: 'seventeen',
  eighteenth: 'eighteen',
  nineteenth: 'nineteen',
  twentieth: 'twenty',
  thirtieth: 'thirty',
};
const SPELLING: Record<string, string> = { ok: 'okay', alright: 'all right' };
const FILLERS = new Set(['um', 'uh', 'hmm', 'mm', 'er', 'ah']);

/** Lowercase words with punctuation stripped, numbers spelled out and ordinals made cardinal. */
export function normalizeWords(text: string): string[] {
  const spelled = text
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, '$1') // 1,000 → 1000
    .replace(/\$(\d+(?:\.\d+)?)/g, '$1 dollars')
    .replace(/(\d)\s*([ap])\.?\s?m\b\.?/g, '$1 $2m') // 4 p.m. → 4 pm
    .replace(/(\d):(\d)/g, '$1 $2') // 6:30 → 6 30
    .replace(/(\d+)\.(\d+)/g, '$1 point $2')
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/%/g, ' percent')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '') // don't → dont
    .replace(/\d+/g, (digits) => ` ${numberToWords(Number(digits))} `)
    .replace(/[^a-z0-9\s]/g, ' ');
  return spelled
    .split(/\s+/)
    .filter((w) => w !== '' && !FILLERS.has(w))
    .flatMap((w) => (ORDINALS[w] ?? SPELLING[w] ?? w).split(' '));
}

/** Word-level edit distance (substitutions + insertions + deletions). */
export function editDistance(reference: readonly string[], hypothesis: readonly string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_v, j) => j);
  for (let i = 1; i <= reference.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= hypothesis.length; j += 1) {
      const same = reference[i - 1] === hypothesis[j - 1];
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (same ? 0 : 1));
    }
    previous = row;
  }
  return previous[hypothesis.length]!;
}

/** Normalized WER of one utterance (edits over reference words). */
export function wer(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const edits = editDistance(ref, normalizeWords(hypothesis));
  return ref.length === 0 ? (edits === 0 ? 0 : 1) : edits / ref.length;
}

/** Whether the term's normalized words appear, in order and together, in the hypothesis. */
export function hasTerm(term: string, hypothesis: string): boolean {
  const needle = normalizeWords(term).join(' ');
  return ` ${normalizeWords(hypothesis).join(' ')} `.includes(` ${needle} `);
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  ]!;
}

/** What happened to one clip played into the call. */
export interface UtteranceResult {
  id: string;
  condition: string;
  voice: string;
  reference: string;
  keyTerms: readonly string[];
  /** The committed turns' text, joined in order. */
  hypothesis: string;
  /** Turns committed for this one clip: 1 is right, 2+ is a split, 0 is unheard. */
  commits: number;
  /** End of the clip's speech to the first committed turn (the final caption reaching the phone). */
  commitMs?: number;
  /** Whether a reply is expected (floor-control words such as "stop" get none). */
  expectReply: boolean;
  replyHeard: boolean;
}

export interface ConditionScore {
  condition: string;
  utterances: number;
  /** Total edits over total reference words, across the condition (0.05 = 5%). */
  wer: number;
  keyTermRecall: number;
  keyTermsMissed: string[];
  /** Share of clips committed as more than one turn. */
  splitRate: number;
  /** Share of clips with no committed turn. */
  unheardRate: number;
  commitP50: number | null;
  commitP95: number | null;
  textToAudioP50: number | null;
  textToAudioP95: number | null;
  /** Share of clips expecting a reply whose reply was heard. */
  replyHeardRate: number;
}

/**
 * `textToAudioMs` are the gateway's own first-text-to-first-TTS-audio times for this condition's
 * replies (its `tts_first_audio` log events); empty when the gateway's log is not readable.
 */
export function scoreCondition(
  condition: string,
  results: readonly UtteranceResult[],
  textToAudioMs: readonly number[] = [],
): ConditionScore {
  let edits = 0;
  let words = 0;
  let terms = 0;
  let found = 0;
  const missed: string[] = [];
  for (const r of results) {
    const ref = normalizeWords(r.reference);
    edits += editDistance(ref, normalizeWords(r.hypothesis));
    words += ref.length;
    for (const term of r.keyTerms) {
      terms += 1;
      if (hasTerm(term, r.hypothesis)) found += 1;
      else missed.push(`${r.id}/${r.voice}: ${term}`);
    }
  }
  const n = results.length;
  const replyExpected = results.filter((r) => r.expectReply);
  const commits = results.flatMap((r) => (r.commitMs === undefined ? [] : [r.commitMs]));
  return {
    condition,
    utterances: n,
    wer: words === 0 ? 0 : edits / words,
    keyTermRecall: terms === 0 ? 1 : found / terms,
    keyTermsMissed: missed,
    splitRate: n === 0 ? 0 : results.filter((r) => r.commits > 1).length / n,
    unheardRate: n === 0 ? 0 : results.filter((r) => r.commits === 0).length / n,
    commitP50: percentile(commits, 50),
    commitP95: percentile(commits, 95),
    textToAudioP50: percentile(textToAudioMs, 50),
    textToAudioP95: percentile(textToAudioMs, 95),
    replyHeardRate:
      replyExpected.length === 0
        ? 1
        : replyExpected.filter((r) => r.replyHeard).length / replyExpected.length,
  };
}

export interface BargeIn {
  /** Caller's interruption onset to the reply going quiet at the phone; null if it never did. */
  stopMs: number | null;
  /**
   * The gateway's barge-in decision (its `barge_in` log event) to the reply going quiet at the
   * phone: the OBSERVABILITY_AND_SLOS §3 measure. Only with a local gateway, whose clock is ours.
   */
  detectedToStopMs?: number;
}

export interface ProofReport {
  mode: 'full' | 'quick';
  conditions: ConditionScore[];
  bargeIn?: BargeIn;
}

/** Limits per condition; a condition without an entry is judged against the baseline only. */
export interface Thresholds {
  minKeyTermRecall: Record<string, number>;
  maxWer: Record<string, number>;
  /** How far (in percentage points) a score may fall behind the baseline. */
  baselineSlackPoints: number;
  bargeInStopMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minKeyTermRecall: { clean: 0.95, narrowband: 0.85 },
  maxWer: { clean: 0.08, narrowband: 0.15 },
  baselineSlackPoints: 3,
  // OBSERVABILITY_AND_SLOS §3: barge-in to audible stop p95 < 400 ms.
  bargeInStopMs: 400,
};

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

/**
 * Reasons this run fails: fixed limits first, then anything worse than the baseline by more than
 * the slack. Empty means pass. A quick run is only compared with a quick baseline (different clips).
 */
export function judge(
  report: ProofReport,
  thresholds: Thresholds,
  baseline?: ProofReport,
): string[] {
  const reasons: string[] = [];
  const slack = thresholds.baselineSlackPoints / 100;
  for (const score of report.conditions) {
    const c = score.condition;
    const minRecall = thresholds.minKeyTermRecall[c];
    if (minRecall !== undefined && score.keyTermRecall < minRecall) {
      reasons.push(`${c}: key-term recall ${pct(score.keyTermRecall)} < ${pct(minRecall)}`);
    }
    const maxWer = thresholds.maxWer[c];
    if (maxWer !== undefined && score.wer > maxWer) {
      reasons.push(`${c}: WER ${pct(score.wer)} > ${pct(maxWer)}`);
    }
    const before =
      baseline?.mode === report.mode
        ? baseline.conditions.find((b) => b.condition === c)
        : undefined;
    if (before === undefined) continue;
    if (score.wer > before.wer + slack) {
      reasons.push(`${c}: WER ${pct(score.wer)} worse than baseline ${pct(before.wer)}`);
    }
    if (score.keyTermRecall < before.keyTermRecall - slack) {
      reasons.push(
        `${c}: key-term recall ${pct(score.keyTermRecall)} worse than baseline ${pct(before.keyTermRecall)}`,
      );
    }
    if (score.splitRate > before.splitRate + slack) {
      reasons.push(
        `${c}: split rate ${pct(score.splitRate)} worse than baseline ${pct(before.splitRate)}`,
      );
    }
  }
  if (report.bargeIn !== undefined) {
    const stop =
      report.bargeIn.stopMs === null
        ? null
        : (report.bargeIn.detectedToStopMs ?? report.bargeIn.stopMs);
    if (stop === null) reasons.push('barge-in: the reply never stopped');
    else if (stop > thresholds.bargeInStopMs) {
      reasons.push(`barge-in: reply stopped after ${stop} ms > ${thresholds.bargeInStopMs} ms`);
    }
  }
  return reasons;
}

const ms = (x: number | null) => (x === null ? '-' : String(Math.round(x)));

/** A short table for people. */
export function formatTable(report: ProofReport): string {
  const header = [
    'condition',
    'clips',
    'WER',
    'key terms',
    'split',
    'unheard',
    'commit p50/p95',
    'text->audio p50/p95',
    'reply heard',
  ];
  const rows = report.conditions.map((s) => [
    s.condition,
    String(s.utterances),
    pct(s.wer),
    pct(s.keyTermRecall),
    pct(s.splitRate),
    pct(s.unheardRate),
    `${ms(s.commitP50)}/${ms(s.commitP95)} ms`,
    `${ms(s.textToAudioP50)}/${ms(s.textToAudioP95)} ms`,
    pct(s.replyHeardRate),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join('  ');
  const out = [line(header), ...rows.map(line)];
  if (report.bargeIn !== undefined) {
    const detected = report.bargeIn.detectedToStopMs;
    out.push(
      `barge-in: reply stopped ${ms(report.bargeIn.stopMs)} ms after the caller started` +
        (detected === undefined ? '' : `, ${ms(detected)} ms after the gateway decided`),
    );
  }
  return out.join('\n');
}
