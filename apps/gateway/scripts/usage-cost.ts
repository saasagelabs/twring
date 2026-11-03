/**
 * Cost per call minute from real calls.
 *
 *   ssh … 'journalctl -u cord-gateway --since "-7 days" -o cat' |
 *     pnpm --filter @twring/gateway exec tsx scripts/usage-cost.ts --stt 0.0077 --tts 0.05 --room 0.001
 *
 * Reads the gateway's JSON log on standard input, totals every `call_usage` line, and prices it
 * with the given rates (USD: STT per minute of audio, TTS per 1,000 characters, room per
 * connected minute) through the gateway's own `estimateCost`.
 */
import { readFileSync } from 'node:fs';

import type { CallUsage } from '@twring/contracts';

import { estimateCost, type UsageRates } from '../src/calls/usage';

export interface UsageReport {
  calls: number;
  /** The gateway's connected time: roughly how long the calls lasted. */
  callMinutes: number;
  totalUsd: number;
  perCallMinuteUsd: number;
  byService: { stt: number; tts: number; room: number };
  /** One day's cost for `people` each calling `minutesEach` at this mix. */
  projectDayUsd(people: number, minutesEach: number): number;
}

type Totals = Pick<CallUsage, 'stt_audio_s' | 'tts_chars' | 'gateway_connected_s'>;

const number = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0);

export function summarizeUsage(lines: readonly string[], rates: UsageRates): UsageReport {
  const totals: Totals = { stt_audio_s: 0, tts_chars: 0, gateway_connected_s: 0 };
  let calls = 0;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.event !== 'call_usage') continue;
    calls += 1;
    totals.stt_audio_s += number(entry.stt_audio_s);
    totals.tts_chars += number(entry.tts_chars);
    totals.gateway_connected_s += number(entry.gateway_connected_s);
  }
  const only = (part: Partial<UsageRates>) =>
    estimateCost(totals as CallUsage, {
      sttPerMinute: 0,
      ttsPer1kChars: 0,
      roomPerMinute: 0,
      ...part,
    }) ?? 0;
  const byService = {
    stt: only({ sttPerMinute: rates.sttPerMinute }),
    tts: only({ ttsPer1kChars: rates.ttsPer1kChars }),
    room: only({ roomPerMinute: rates.roomPerMinute }),
  };
  const totalUsd = byService.stt + byService.tts + byService.room;
  const callMinutes = totals.gateway_connected_s / 60;
  const perCallMinuteUsd = callMinutes === 0 ? 0 : totalUsd / callMinutes;
  return {
    calls,
    callMinutes,
    totalUsd,
    perCallMinuteUsd,
    byService,
    projectDayUsd: (people, minutesEach) => people * minutesEach * perCallMinuteUsd,
  };
}

function arg(name: string): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? Number.NaN : Number(process.argv[index + 1]);
  if (!(value >= 0)) {
    console.error(`--${name} <USD rate> is required`);
    process.exit(2);
  }
  return value;
}

if (process.argv[1]?.endsWith('usage-cost.ts')) {
  const report = summarizeUsage(readFileSync(0, 'utf8').split(/\r?\n/), {
    sttPerMinute: arg('stt'),
    ttsPer1kChars: arg('tts'),
    roomPerMinute: arg('room'),
  });
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  console.log(
    JSON.stringify(
      {
        calls: report.calls,
        callMinutes: Math.round(report.callMinutes * 10) / 10,
        totalUsd: round(report.totalUsd),
        perCallMinuteUsd: round(report.perCallMinuteUsd),
        byService: {
          stt: round(report.byService.stt),
          tts: round(report.byService.tts),
          room: round(report.byService.room),
        },
        day300x10min: round(report.projectDayUsd(300, 10)),
        day300x30min: round(report.projectDayUsd(300, 30)),
      },
      null,
      2,
    ),
  );
}
