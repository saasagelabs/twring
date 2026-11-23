import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME } from './pcm';
import { Downsampler48To16 } from './resample';
import { NARROWBAND_HF_RATIO, SpeechStats } from './speech-stats';

const GATE = -35;

/**
 * Speech-like multitone at 48 kHz: tones every 50 Hz from `low` to `high` with random phases and a
 * 1/f power slope (speech energy falls with frequency), peaking near `peak` of full scale.
 */
function multitone(low: number, high: number, seconds: number, peak = 0.3): Int16Array[] {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const tones: { f: number; a: number; p: number }[] = [];
  for (let f = low; f <= high; f += 50) tones.push({ f, a: 1 / Math.sqrt(f), p: random() * 6.283 });
  const total = Math.round(48_000 * seconds);
  const raw = new Float64Array(total);
  let max = 0;
  for (let n = 0; n < total; n += 1) {
    let v = 0;
    for (const t of tones) v += t.a * Math.sin((2 * Math.PI * t.f * n) / 48_000 + t.p);
    raw[n] = v;
    max = Math.max(max, Math.abs(v));
  }
  const frames: Int16Array[] = [];
  for (let i = 0; i + SAMPLES_PER_FRAME <= total; i += SAMPLES_PER_FRAME) {
    const frame = new Int16Array(SAMPLES_PER_FRAME);
    for (let j = 0; j < SAMPLES_PER_FRAME; j += 1)
      frame[j] = Math.round((raw[i + j]! / max) * peak * 32767);
    frames.push(frame);
  }
  return frames;
}

function measure(frames: Int16Array[]): SpeechStats {
  const down = new Downsampler48To16();
  const stats = new SpeechStats(GATE);
  for (const frame of frames) stats.add(down.process(frame));
  return stats;
}

describe('SpeechStats', () => {
  it('scores wideband speech-like audio high', () => {
    const summary = measure(multitone(100, 7000, 1)).summary()!;
    expect(summary.hf_ratio).toBeGreaterThan(0.02);
    expect(summary.narrowband).toBe(false);
  });

  it('scores 300-3400 Hz band-limited audio as narrowband', () => {
    const summary = measure(multitone(300, 3400, 1)).summary()!;
    expect(summary.hf_ratio).toBeLessThan(0.001);
    expect(summary.hf_ratio).toBeLessThan(NARROWBAND_HF_RATIO);
    expect(summary.narrowband).toBe(true);
  });

  it('reports level in dBFS', () => {
    const summary = measure(multitone(300, 3400, 0.5, 0.5)).summary()!;
    expect(summary.speech_peak_dbfs).toBeLessThanOrEqual(0);
    expect(summary.speech_peak_dbfs).toBeGreaterThan(-9);
    expect(summary.speech_rms_dbfs).toBeLessThan(summary.speech_peak_dbfs);
  });

  it('ignores silence and quiet frames, so they do not lower the level', () => {
    const speech = multitone(300, 3400, 0.5, 0.5);
    const quiet = Array.from({ length: 100 }, () => new Int16Array(SAMPLES_PER_FRAME).fill(10));
    const silence = Array.from({ length: 100 }, () => new Int16Array(SAMPLES_PER_FRAME));
    const alone = measure(speech).summary()!;
    const mixed = measure([...silence, ...speech, ...quiet]).summary()!;
    expect(Math.abs(mixed.speech_rms_dbfs - alone.speech_rms_dbfs)).toBeLessThan(0.5);
  });

  it('has no summary when the caller never spoke', () => {
    const silence = Array.from({ length: 50 }, () => new Int16Array(SAMPLES_PER_FRAME));
    expect(measure(silence).summary()).toBeUndefined();
  });
});
