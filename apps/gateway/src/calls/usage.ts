import type { GatewayEnv } from '@twring/config/gateway';
import type { CallHistoryItem, CallUsage } from '@twring/contracts';

/** USD cost rates from config. 0 means unknown: that component is left out of the estimate. */
export interface UsageRates {
  sttPerMinute: number;
  ttsPer1kChars: number;
  roomPerMinute: number;
}

/** The rate settings; any left out count as unknown (0). */
export type RateEnv = Partial<
  Pick<
    GatewayEnv,
    'CORD_RATE_STT_PER_MIN' | 'CORD_RATE_TTS_PER_1K_CHARS' | 'CORD_RATE_ROOM_PER_MIN'
  >
>;

export function usageRates(env: RateEnv): UsageRates {
  return {
    sttPerMinute: env.CORD_RATE_STT_PER_MIN ?? 0,
    ttsPer1kChars: env.CORD_RATE_TTS_PER_1K_CHARS ?? 0,
    roomPerMinute: env.CORD_RATE_ROOM_PER_MIN ?? 0,
  };
}

/**
 * Estimated call cost in USD from the configured rates, or undefined when no rate is set. STT is
 * priced on streamed audio, TTS on characters, the room on the gateway's connected time (the
 * caller's minutes are roughly the same again; set the room rate per call-minute accordingly).
 */
export function estimateCost(
  usage: Omit<CallUsage, 'estimated_cost_usd'>,
  rates: UsageRates | undefined,
): number | undefined {
  if (rates === undefined) return undefined;
  const { sttPerMinute, ttsPer1kChars, roomPerMinute } = rates;
  if (sttPerMinute === 0 && ttsPer1kChars === 0 && roomPerMinute === 0) return undefined;
  const cost =
    (usage.stt_audio_s / 60) * sttPerMinute +
    (usage.tts_chars / 1000) * ttsPer1kChars +
    (usage.gateway_connected_s / 60) * roomPerMinute;
  return Math.round(cost * 1e6) / 1e6;
}

/** Seconds, rounded to 0.1 s for logs and storage. */
export function seconds(ms: number): number {
  return Math.round(Math.max(0, ms) / 100) / 10;
}

/** One day × agent bucket of usage, for later dashboards. */
export interface UsageRollup {
  /** UTC day of the call's start, `YYYY-MM-DD`. */
  day: string;
  agent_id: string;
  calls: number;
  /** Calls in this bucket that carried usage (older rows may not). */
  calls_with_usage: number;
  duration_s: number;
  usage: CallUsage;
}

const SUMMED_KEYS = [
  'stt_audio_s',
  'stt_connected_s',
  'tts_chars',
  'tts_audio_s',
  'agent_turns',
  'agent_turns_completed',
  'agent_turns_failed',
  'barge_ins',
  'gateway_connected_s',
  'stt_reconnects',
  'tts_reconnects',
] as const satisfies readonly (keyof CallUsage)[];

function emptyUsage(): CallUsage {
  return {
    stt_audio_s: 0,
    stt_connected_s: 0,
    tts_chars: 0,
    tts_audio_s: 0,
    agent_turns: 0,
    agent_turns_completed: 0,
    agent_turns_failed: 0,
    barge_ins: 0,
    gateway_connected_s: 0,
    stt_reconnects: 0,
    tts_reconnects: 0,
  };
}

/** Sums call history into per-day, per-agent buckets, oldest day first. */
export function rollupUsage(items: readonly CallHistoryItem[]): UsageRollup[] {
  const buckets = new Map<string, UsageRollup>();
  for (const item of items) {
    const day = item.started_at.slice(0, 10);
    const key = `${day}|${item.agent_id}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        day,
        agent_id: item.agent_id,
        calls: 0,
        calls_with_usage: 0,
        duration_s: 0,
        usage: emptyUsage(),
      };
      buckets.set(key, bucket);
    }
    bucket.calls += 1;
    bucket.duration_s += item.duration_s;
    const usage = item.usage;
    if (usage === undefined) continue;
    bucket.calls_with_usage += 1;
    for (const k of SUMMED_KEYS) bucket.usage[k] = round1(bucket.usage[k] + usage[k]);
    if (usage.estimated_cost_usd !== undefined) {
      bucket.usage.estimated_cost_usd =
        Math.round(((bucket.usage.estimated_cost_usd ?? 0) + usage.estimated_cost_usd) * 1e6) / 1e6;
    }
  }
  return [...buckets.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.agent_id.localeCompare(b.agent_id),
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
