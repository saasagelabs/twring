import { describe, expect, it } from 'vitest';

import { summarizeUsage } from './usage-cost';

const usageLine = (fields: Record<string, number>) =>
  JSON.stringify({ event: 'call_usage', call_id: 'call_x', ...fields });

describe('usage cost report', () => {
  const rates = { sttPerMinute: 0.01, ttsPer1kChars: 0.05, roomPerMinute: 0.002 };

  it('totals call_usage lines and prices a call minute with the given rates', () => {
    const report = summarizeUsage(
      [
        usageLine({ stt_audio_s: 120, tts_chars: 1000, gateway_connected_s: 120 }),
        usageLine({ stt_audio_s: 60, tts_chars: 500, gateway_connected_s: 60 }),
        JSON.stringify({ event: 'call_created', call_id: 'call_y' }),
        'not json',
      ],
      rates,
    );
    expect(report.calls).toBe(2);
    expect(report.callMinutes).toBe(3);
    // STT 3 min × 0.01 + TTS 1.5k chars × 0.05 + room 3 min × 0.002 = 0.03 + 0.075 + 0.006
    expect(report.totalUsd).toBeCloseTo(0.111, 6);
    expect(report.perCallMinuteUsd).toBeCloseTo(0.037, 6);
    expect(report.byService.stt).toBeCloseTo(0.03, 6);
    expect(report.byService.tts).toBeCloseTo(0.075, 6);
    expect(report.byService.room).toBeCloseTo(0.006, 6);
  });

  it('gives zeros, not NaN, when there is no usage', () => {
    const report = summarizeUsage([], rates);
    expect(report).toMatchObject({ calls: 0, callMinutes: 0, totalUsd: 0, perCallMinuteUsd: 0 });
  });

  it('projects a day for a number of people and minutes each', () => {
    const report = summarizeUsage(
      [usageLine({ stt_audio_s: 60, tts_chars: 1000, gateway_connected_s: 60 })],
      rates,
    );
    // 0.01 + 0.05 + 0.002 = 0.062 per call minute; 300 people × 10 minutes.
    expect(report.projectDayUsd(300, 10)).toBeCloseTo(186, 6);
  });
});
