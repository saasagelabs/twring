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

  it('is stable on odd-sized, empty and clipped frames', () => {
    const stats = new SpeechStats(GATE);
    stats.add(new Int16Array(0));
    stats.add(new Int16Array(7).fill(-32768));
    stats.add(new Int16Array(321).fill(32767));
    const summary = stats.summary()!;
    for (const value of [summary.speech_rms_dbfs, summary.speech_peak_dbfs, summary.hf_ratio])
      expect(Number.isFinite(value)).toBe(true);
    expect(summary.speech_peak_dbfs).toBe(0);
  });

  it('keeps precision over a two-hour call of loud speech', () => {
    const frames = multitone(100, 7000, 0.2, 0.9).map((f) => new Downsampler48To16().process(f));
    const short = new SpeechStats(GATE);
    const long = new SpeechStats(GATE);
    for (const f of frames) short.add(f);
    // 2 h of 20 ms frames, replaying the same 0.2 s.
    for (let i = 0; i < 360_000; i += 1) long.add(frames[i % frames.length]!);
    expect(long.summary()!.speech_rms_dbfs).toBeCloseTo(short.summary()!.speech_rms_dbfs, 0);
    expect(Number.isFinite(long.summary()!.hf_ratio)).toBe(true);
  });

  it('a fresh instance per call starts from nothing', () => {
    measure(multitone(100, 7000, 0.2));
    expect(new SpeechStats(GATE).summary()).toBeUndefined();
  });

  // Codec bands through a phone's resampling: Bluetooth mSBC (16 kHz, up to ~7-8 kHz) must not be
  // flagged; CVSD (8 kHz, 300-3400 Hz) must be. The source is sampled at the codec rate, then
  // upsampled to 48 kHz with a windowed-sinc filter, as the phone does, then down to 16 kHz.
  function viaCodecRate(low: number, high: number, rate: number): Int16Array[] {
    const tones: { f: number; a: number; p: number }[] = [];
    let seed = 11;
    for (let f = low; f <= high; f += 50) {
      seed = (seed * 16807) % 2147483647;
      tones.push({ f, a: 1 / Math.sqrt(f), p: (seed / 2147483647) * 6.283 });
    }
    const n = rate; // one second
    const src = new Float64Array(n);
    let max = 0;
    for (let i = 0; i < n; i += 1) {
      let v = 0;
      for (const t of tones) v += t.a * Math.sin((2 * Math.PI * t.f * i) / rate + t.p);
      src[i] = v;
      max = Math.max(max, Math.abs(v));
    }
    for (let i = 0; i < n; i += 1) src[i] = Math.round((src[i]! / max) * 0.3 * 32767);
    const factor = 48_000 / rate;
    const half = 32;
    const out = new Float64Array(n * factor);
    for (let k = 0; k < out.length; k += 1) {
      const t = k / factor;
      let v = 0;
      for (let j = Math.floor(t) - half + 1; j <= Math.floor(t) + half; j += 1) {
        if (j < 0 || j >= n) continue;
        const x = t - j;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / half);
        v += src[j]! * sinc * window;
      }
      out[k] = v;
    }
    const frames: Int16Array[] = [];
    for (let i = 0; i + SAMPLES_PER_FRAME <= out.length; i += SAMPLES_PER_FRAME) {
      const frame = new Int16Array(SAMPLES_PER_FRAME);
      for (let j = 0; j < SAMPLES_PER_FRAME; j += 1)
        frame[j] = Math.max(-32768, Math.min(32767, Math.round(out[i + j]!)));
      frames.push(frame);
    }
    return frames;
  }

  it('does not flag mSBC wideband (50-7000 Hz at 16 kHz) after 16k to 48k to 16k', () => {
    const summary = measure(viaCodecRate(50, 7000, 16_000)).summary()!;
    expect(summary.narrowband).toBe(false);
  });

  it('flags CVSD narrowband (300-3400 Hz at 8 kHz) after 8k to 48k to 16k', () => {
    const summary = measure(viaCodecRate(300, 3400, 8_000)).summary()!;
    expect(summary.narrowband).toBe(true);
  });
});
