import { describe, expect, it } from 'vitest';

import { serverReplyTimes, summarize } from './load-test-report';

const turns = (ms: number[]) =>
  ms.map((replyMs, i) => ({ callIndex: i % 4, replyMs, maxGapMs: 40 }));

describe('load test report', () => {
  it('passes inside every budget', () => {
    const report = summarize(
      turns([800, 900, 1000, 1100, 1200]),
      [{ at: 0, percentOfOneCore: 90 }],
      [0, 1, 2, 3].map((callIndex) => ({ callIndex, ok: true })),
    );
    expect(report).toMatchObject({ calls: 4, failedCalls: 0, turns: 5, pass: true });
    expect(report.cpuP95PercentOfServer).toBe(45);
  });

  it('fails on a slow p95, a long gap, high CPU, or a failed call, and says why', () => {
    const report = summarize(
      [...turns([800, 900, 2500]), { callIndex: 1, replyMs: 900, maxGapMs: 450 }],
      [{ at: 0, percentOfOneCore: 170 }],
      [
        { callIndex: 0, ok: true },
        { callIndex: 1, ok: false, reason: 'livekit_disconnected' },
      ],
    );
    expect(report.pass).toBe(false);
    expect(report.failedCalls).toBe(1);
    expect(report.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/p95/),
        expect.stringMatching(/gap/),
        expect.stringMatching(/CPU/),
        expect.stringMatching(/1 call failed/),
      ]),
    );
  });

  it('fails when no turn completed at all', () => {
    expect(summarize([], [], [{ callIndex: 0, ok: false, reason: 'no_reply' }]).pass).toBe(false);
  });

  it('with a one-call baseline, judges replies by how much load slowed them', () => {
    const ok = [{ callIndex: 0, ok: true }];
    // Baseline p95 2400 ms (slow sentences, agent think time): 2800 is within +500 ms.
    expect(summarize(turns([1200, 2800]), [], ok, { baselineP95Ms: 2400 }).pass).toBe(true);
    const slower = summarize(turns([1200, 3000]), [], ok, { baselineP95Ms: 2400 });
    expect(slower.pass).toBe(false);
    expect(slower.reasons).toEqual([expect.stringMatching(/p95 3000 ms > 2900 ms/)]);
  });

  it("judges by the gateway's own reply time when it is given, the phones' time is only shown", () => {
    const ok = [{ callIndex: 0, ok: true }];
    // The phones saw slow replies (their own process is busy), but the gateway was steady.
    const steady = summarize(turns([1200, 5000]), [], ok, {
      server: { replyMs: [600, 700, 820], baselineP95Ms: 800 },
    });
    expect(steady.pass).toBe(true);
    expect(steady.serverReplyP95).toBe(820);
    const slowed = summarize(turns([1200]), [], ok, {
      server: { replyMs: [600, 1200], baselineP95Ms: 800 },
    });
    expect(slowed.reasons).toEqual([expect.stringMatching(/gateway reply p95 1200 ms > 1100 ms/)]);
  });

  it('fails a step whose gateway log has no timing, instead of skipping the reply check', () => {
    const report = summarize(turns([900]), [], [{ callIndex: 0, ok: true }], {
      server: { replyMs: [], baselineP95Ms: 800 },
    });
    expect(report.pass).toBe(false);
    expect(report.reasons).toEqual([expect.stringMatching(/no gateway timing/)]);
  });

  it('notes a stall seen by the phones without failing when the gateway timing is known', () => {
    const report = summarize(
      [{ callIndex: 0, replyMs: 900, maxGapMs: 260 }],
      [],
      [{ callIndex: 0, ok: true }],
      { server: { replyMs: [700], baselineP95Ms: 800 } },
    );
    expect(report.pass).toBe(true);
    expect(report.notes).toEqual([expect.stringMatching(/phones saw a 260 ms audio stall/)]);
  });
});

describe('serverReplyTimes', () => {
  const at = (call: string, event: string, time: number) => ({ call_id: call, event, time });

  it("takes each turn's commit to first published audio, for this step's calls only", () => {
    const log = [
      at('call_a', 'turn_committed', 1000),
      at('call_a', 'audio_first_published', 1650),
      at('call_b', 'turn_committed', 2000),
      at('call_b', 'audio_first_published', 2900),
      at('call_a', 'turn_committed', 5000),
      at('call_a', 'audio_first_published', 5700),
      at('call_other', 'turn_committed', 0),
      at('call_other', 'audio_first_published', 9999),
    ];
    expect(serverReplyTimes(log, new Set(['call_a', 'call_b']))).toEqual([650, 900, 700]);
  });

  it('skips a turn that never published audio (a barge-in or a failed reply)', () => {
    const log = [
      at('call_a', 'turn_committed', 1000),
      at('call_a', 'turn_committed', 3000),
      at('call_a', 'audio_first_published', 3400),
    ];
    expect(serverReplyTimes(log, new Set(['call_a']))).toEqual([400]);
  });
});
