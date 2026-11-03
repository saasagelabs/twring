/**
 * Load test verdict: turns the samples from one step
 * of simulated calls into a pass or fail against the wave 1 budgets, with the reasons.
 */

export interface TurnSample {
  callIndex: number;
  /** Which of the caller's lines (0-based), for the per-line breakdown. */
  turnIndex?: number;
  /** End of the caller's speech to the first audible reply frame. */
  replyMs: number;
  /** Longest pause between reply audio frames within that reply. */
  maxGapMs: number;
}

export interface CpuSample {
  at: number;
  /** The gateway process's CPU over the last interval; 100 is one full core. */
  percentOfOneCore: number;
}

export interface CallOutcome {
  callIndex: number;
  ok: boolean;
  reason?: string;
}

export interface LoadReport {
  calls: number;
  failedCalls: number;
  turns: number;
  replyP50: number;
  replyP95: number;
  worstGapMs: number;
  cpuP95PercentOfServer: number;
  /** The gateway's own commit-to-first-published-audio p95, when its log was read. */
  serverReplyP95?: number;
  pass: boolean;
  reasons: string[];
  /** Seen but not judged (see `summarize`). */
  notes: string[];
}

/** The server's cores: CPU is reported as a share of the whole server. */
export const SERVER_CORES = 2;

/**
 * Wave 1 budgets. Without a baseline, replies are held to OBSERVABILITY_AND_SLOS §3 (900 ms commit
 * + 800 ms text to audio). With a one-call baseline, load may add at most `loadSlowdownMs` to the
 * reply p95: the absolute time also holds the test agent's think time and how long speech
 * recognition takes to decide each sentence ended, which load does not change.
 */
export const BUDGET = {
  replyP95Ms: 1700,
  loadSlowdownMs: 500,
  /** What load may add to the gateway's own reply time (commit to first audio published). */
  serverSlowdownMs: 300,
  maxGapMs: 200,
  cpuPercentOfServer: 70,
} as const;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

export function summarize(
  samples: TurnSample[],
  cpu: CpuSample[],
  calls: CallOutcome[],
  options: {
    baselineP95Ms?: number;
    /**
     * The gateway's own reply times from its log. When given, they decide the reply check: the
     * phones share one busy process, so their timing is shown but not judged.
     */
    server?: { replyMs: number[]; baselineP95Ms: number };
  } = {},
): LoadReport {
  const replies = samples.map((s) => s.replyMs);
  const failedCalls = calls.filter((c) => !c.ok).length;
  const replyP95 = percentile(replies, 95);
  const worstGapMs = Math.max(0, ...samples.map((s) => s.maxGapMs));
  const cpuP95PercentOfServer =
    cpu.length === 0
      ? 0
      : percentile(
          cpu.map((c) => c.percentOfOneCore),
          95,
        ) / SERVER_CORES;
  const reasons: string[] = [];
  const serverReplyP95 =
    options.server === undefined ? undefined : percentile(options.server.replyMs, 95);
  if (samples.length === 0) reasons.push('no turn completed');
  else if (options.server !== undefined && options.server.replyMs.length === 0) {
    reasons.push('no gateway timing in the log (turn_committed / audio_first_published)');
  } else if (options.server !== undefined && serverReplyP95 !== undefined) {
    const limit = options.server.baselineP95Ms + BUDGET.serverSlowdownMs;
    if (serverReplyP95 > limit) {
      reasons.push(`gateway reply p95 ${Math.round(serverReplyP95)} ms > ${limit} ms`);
    }
  } else {
    const limit =
      options.baselineP95Ms === undefined
        ? BUDGET.replyP95Ms
        : options.baselineP95Ms + BUDGET.loadSlowdownMs;
    if (replyP95 > limit) reasons.push(`reply p95 ${Math.round(replyP95)} ms > ${limit} ms`);
  }
  // Stalls are seen by the phones, which share the test machine with the gateway: with the
  // gateway's own timing known they are noted, not judged.
  const notes: string[] = [];
  if (worstGapMs > BUDGET.maxGapMs) {
    if (options.server === undefined) {
      reasons.push(`audio gap ${worstGapMs} ms > ${BUDGET.maxGapMs} ms`);
    } else notes.push(`the phones saw a ${worstGapMs} ms audio stall`);
  }
  if (cpuP95PercentOfServer > BUDGET.cpuPercentOfServer) {
    reasons.push(`CPU p95 ${Math.round(cpuP95PercentOfServer)}% > ${BUDGET.cpuPercentOfServer}%`);
  }
  if (failedCalls > 0) reasons.push(`${failedCalls} call${failedCalls === 1 ? '' : 's'} failed`);
  return {
    calls: calls.length,
    failedCalls,
    turns: samples.length,
    replyP50: percentile(replies, 50),
    replyP95,
    worstGapMs,
    cpuP95PercentOfServer,
    ...(serverReplyP95 !== undefined && { serverReplyP95 }),
    pass: reasons.length === 0,
    reasons,
    notes,
  };
}

/** One line of the gateway's JSON log, as far as the load test reads it. */
export interface GatewayLogEvent {
  call_id?: string;
  event?: string;
  time?: number;
}

/**
 * The gateway's own reply times for one step's calls: for each turn, `turn_committed` (it knew
 * the caller had finished) to `audio_first_published` (the first reply audio left for the
 * phone). A turn that never published audio (barge-in, failed reply) is skipped.
 */
export function serverReplyTimes(
  log: readonly GatewayLogEvent[],
  callIds: ReadonlySet<string>,
): number[] {
  const committedAt = new Map<string, number>();
  const times: number[] = [];
  for (const entry of log) {
    const { call_id: call, event, time } = entry;
    if (call === undefined || time === undefined || !callIds.has(call)) continue;
    if (event === 'turn_committed') committedAt.set(call, time);
    else if (event === 'audio_first_published') {
      const committed = committedAt.get(call);
      if (committed !== undefined) times.push(time - committed);
      committedAt.delete(call);
    }
  }
  return times;
}
