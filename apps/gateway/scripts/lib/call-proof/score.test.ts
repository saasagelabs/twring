import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THRESHOLDS,
  bargeDecision,
  formatTable,
  hasTerm,
  hypothesisOf,
  judge,
  normalizeWords,
  numberToWords,
  scoreCondition,
  wer,
  type ConditionScore,
  type ProofReport,
  type UtteranceResult,
} from './score';

describe('normalizeWords', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeWords('Hey, this is a Twring call. Can you hear me?')).toEqual(
      'hey this is a twring call can you hear me'.split(' '),
    );
  });

  it('spells numbers one way', () => {
    expect(normalizeWords('2,500 dollars')).toEqual(normalizeWords('$2500'));
    expect(normalizeWords('6:30')).toEqual(['six', 'thirty']);
    expect(normalizeWords('December 3rd')).toEqual(normalizeWords('december third'));
    expect(normalizeWords('4 p.m.')).toEqual(normalizeWords('4 PM'));
    expect(normalizeWords('12%')).toEqual(normalizeWords('twelve percent'));
  });

  it('drops fillers and joins contractions', () => {
    expect(normalizeWords("Um, that's OK")).toEqual(['thats', 'okay']);
  });

  it('numberToWords', () => {
    expect(numberToWords(0)).toBe('zero');
    expect(numberToWords(105)).toBe('one hundred five');
    expect(numberToWords(2500)).toBe('two thousand five hundred');
    expect(numberToWords(1_000_001)).toBe('one million one');
  });
});

describe('wer and key terms', () => {
  it('is zero for the same words in another spelling', () => {
    expect(wer('Set a timer for 15 minutes.', 'set a timer for fifteen minutes')).toBe(0);
  });

  it('counts substitutions, insertions and deletions over reference words', () => {
    expect(wer('a b c d', 'a x c')).toBe(0.5); // one substitution, one deletion
    expect(wer('a b', 'a b c')).toBe(0.5);
    expect(wer('', '')).toBe(0);
  });

  it('finds terms as whole words in order', () => {
    expect(hasTerm('bye for now', 'Okay. Bye for now!')).toBe(true);
    expect(hasTerm('Twring', 'twirling is fun')).toBe(false);
    expect(hasTerm('15 minutes', 'fifteen minutes please')).toBe(true);
    expect(hasTerm('no', 'know')).toBe(false);
  });
});

const result = (over: Partial<UtteranceResult>): UtteranceResult => ({
  id: 'u',
  condition: 'clean',
  voice: 'v',
  reference: 'call Twring now',
  keyTerms: ['Twring'],
  hypothesis: 'call Twring now',
  commits: 1,
  commitMs: 300,
  expectReply: true,
  replyHeard: true,
  ...over,
});

describe('scoreCondition', () => {
  it('pools WER over words and counts splits, unheard clips and replies', () => {
    const score = scoreCondition(
      'clean',
      [
        result({}),
        result({ id: 'b', hypothesis: 'call during now', commits: 2, commitMs: 500 }),
        result({ id: 'c', hypothesis: '', commits: 0, replyHeard: false }),
        result({ id: 'd', expectReply: false, replyHeard: false, commitMs: 100 }),
      ],
      [200, 400],
    );
    expect(score.wer).toBeCloseTo(4 / 12);
    expect(score.keyTermRecall).toBe(0.5);
    expect(score.keyTermsMissed).toEqual(['b/v: Twring', 'c/v: Twring']);
    expect(score.splitRate).toBe(0.25);
    expect(score.unheardRate).toBe(0.25);
    expect(score.replyHeardRate).toBeCloseTo(2 / 3);
    expect(score.commitP50).toBe(300);
    expect(score.commitP95).toBe(500);
    expect(score.textToAudioP50).toBe(200);
    expect(score.textToAudioP95).toBe(400);
  });

  it('has no latency without samples', () => {
    const score = scoreCondition('quiet', []);
    expect(score.commitP50).toBeNull();
    expect(score.textToAudioP95).toBeNull();
  });
});

const condition = (over: Partial<ConditionScore>): ConditionScore => ({
  condition: 'clean',
  utterances: 10,
  wer: 0.03,
  keyTermRecall: 1,
  keyTermsMissed: [],
  splitRate: 0,
  unheardRate: 0,
  commitP50: 300,
  commitP95: 600,
  textToAudioP50: 200,
  textToAudioP95: 400,
  replyHeardRate: 1,
  ...over,
});
const report = (conditions: ConditionScore[], extra: Partial<ProofReport> = {}): ProofReport => ({
  mode: 'full',
  conditions,
  ...extra,
});

describe('judge', () => {
  it('passes within the limits', () => {
    expect(judge(report([condition({})]), DEFAULT_THRESHOLDS)).toEqual([]);
  });

  it('holds clean and narrowband to their own limits, others only to the baseline', () => {
    const reasons = judge(
      report([
        condition({ keyTermRecall: 0.9, wer: 0.1 }),
        condition({ condition: 'narrowband', keyTermRecall: 0.84, wer: 0.16 }),
        condition({ condition: 'quiet', keyTermRecall: 0.5, wer: 0.5 }),
      ]),
      DEFAULT_THRESHOLDS,
    );
    expect(reasons).toEqual([
      'clean: key-term recall 90.0% < 95.0%',
      'clean: WER 10.0% > 8.0%',
      'narrowband: key-term recall 84.0% < 85.0%',
      'narrowband: WER 16.0% > 15.0%',
    ]);
  });

  it('fails on falling behind the baseline by more than 3 points', () => {
    const baseline = report([condition({ condition: 'quiet', wer: 0.1, keyTermRecall: 0.9 })]);
    expect(
      judge(
        report([condition({ condition: 'quiet', wer: 0.129, keyTermRecall: 0.871 })]),
        DEFAULT_THRESHOLDS,
        baseline,
      ),
    ).toEqual([]);
    expect(
      judge(
        report([
          condition({ condition: 'quiet', wer: 0.14, keyTermRecall: 0.85, splitRate: 0.05 }),
        ]),
        DEFAULT_THRESHOLDS,
        baseline,
      ),
    ).toEqual([
      'quiet: WER 14.0% worse than baseline 10.0%',
      'quiet: key-term recall 85.0% worse than baseline 90.0%',
      'quiet: split rate 5.0% worse than baseline 0.0%',
    ]);
  });

  it('compares a quick run only with a quick baseline', () => {
    const baseline = report([condition({ wer: 0 })], { mode: 'quick' });
    expect(judge(report([condition({ wer: 0.07 })]), DEFAULT_THRESHOLDS, baseline)).toEqual([]);
  });

  it('judges barge-in on the gateway decision when known, else on caller onset', () => {
    const at = (stopMs: number | null, detectedToStopMs?: number) =>
      judge(
        report([condition({})], {
          bargeIn: { stopMs, ...(detectedToStopMs !== undefined && { detectedToStopMs }) },
        }),
        DEFAULT_THRESHOLDS,
      );
    expect(at(600, 300)).toEqual([]);
    expect(at(600)).toEqual(['barge-in: reply stopped after 600 ms > 400 ms']);
    expect(at(null)).toEqual(['barge-in: the reply never stopped']);
  });
});

describe('formatTable', () => {
  it('prints one row per condition and the barge-in line', () => {
    const text = formatTable(report([condition({})], { bargeIn: { stopMs: 350 } }));
    expect(text).toContain('clean');
    expect(text).toContain('3.0%');
    expect(text).toContain('barge-in: reply stopped 350 ms after the caller started');
  });
});

describe('key-term matching edge cases', () => {
  it('ignores case and a possessive on the heard word', () => {
    expect(hasTerm('Twring', "TWRING's dashboard")).toBe(true);
    expect(hasTerm('Twring', 'Twring’s dashboard')).toBe(true);
    expect(hasTerm("Twring's", 'the Twring app')).toBe(true);
    expect(hasTerm('SaaSage', 'saasage labs')).toBe(true);
  });

  it('matches a hyphenated spelling either way, but not a word split by a space', () => {
    expect(hasTerm('Rishflips', 'open the Rish-flips dashboard')).toBe(true);
    expect(hasTerm('pull request', 'review the pull-request')).toBe(true);
    expect(hasTerm('Rishflips', 'open the rish flips dashboard')).toBe(false);
  });

  it('matches numbers in digits or words', () => {
    expect(hasTerm('2500 dollars', 'the budget is $2,500 for')).toBe(true);
    expect(hasTerm('December 3', 'on December third at')).toBe(true);
    expect(hasTerm('4 pm', 'at four p.m.')).toBe(true);
    expect(hasTerm('6:30', 'at six thirty tomorrow')).toBe(true);
  });

  it('keeps WER unchanged by possessives and case', () => {
    expect(wer("Check today's orders.", 'check todays orders')).toBe(0);
    expect(wer('Twring is great', "twring's great")).toBeGreaterThan(0);
  });
});

describe('hypothesisOf', () => {
  it('joins a line committed as two turns in turn order, once per turn', () => {
    expect(
      hypothesisOf([
        { turnIndex: 4, text: 'check the calendar first.' },
        { turnIndex: 3, text: 'I was thinking about the launch plan, and' },
        { turnIndex: 4, text: 'check the calendar first.' },
      ]),
    ).toEqual({
      text: 'I was thinking about the launch plan, and check the calendar first.',
      turns: 2,
    });
    expect(hypothesisOf([])).toEqual({ text: '', turns: 0 });
  });

  it('scores a split line on its joined words', () => {
    const joined = hypothesisOf([
      { turnIndex: 1, text: 'Open the Rishflips' },
      { turnIndex: 2, text: 'dashboard.' },
    ]);
    expect(hasTerm('Rishflips dashboard', joined.text)).toBe(true);
    expect(wer('Open the Rishflips dashboard.', joined.text)).toBe(0);
  });
});

describe('bargeDecision', () => {
  const ev = (time: number, event = 'barge_in', call_id = 'c1') => ({ time, event, call_id });
  it('takes the first barge-in of this call at or after the caller started, before the quiet', () => {
    const events = [
      ev(900),
      ev(1800),
      ev(2100),
      ev(2150),
      ev(2120, 'barge_in', 'other'),
      ev(2050, 'tts_first_audio'),
    ];
    expect(bargeDecision(events, 'c1', 2000, 2400)).toBe(2100);
  });

  it('allows a little clock skew around the caller onset and the quiet', () => {
    expect(bargeDecision([ev(1990)], 'c1', 2000, 2400)).toBe(1990);
    expect(bargeDecision([ev(2450)], 'c1', 2000, 2400)).toBe(2450);
  });

  it('never picks an earlier clip barge-in', () => {
    expect(bargeDecision([ev(500), ev(1500)], 'c1', 2000, 2400)).toBeUndefined();
  });
});

describe('baseline and hints', () => {
  it('compares only with a baseline taken with the same hints', () => {
    const baseline = report([condition({ keyTermRecall: 1 })], { hints: [] });
    const run = report([condition({ keyTermRecall: 0.96 })], { hints: ['Claude'] });
    expect(
      judge(
        { ...run, conditions: [condition({ condition: 'quiet', keyTermRecall: 0.5 })] },
        DEFAULT_THRESHOLDS,
        {
          ...baseline,
          conditions: [condition({ condition: 'quiet', keyTermRecall: 1 })],
        },
      ),
    ).toEqual([]);
  });

  it('prints the hints under the table', () => {
    expect(formatTable(report([condition({})], { hints: ['Claude', 'Twring'] }))).toContain(
      'keyterm hints: Claude, Twring',
    );
    expect(formatTable(report([condition({})], { hints: [] }))).toContain('keyterm hints: none');
  });
});
