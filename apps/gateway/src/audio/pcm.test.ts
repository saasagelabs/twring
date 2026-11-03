import { describe, expect, it } from 'vitest';

import {
  FrameDelay,
  PRESENCE_TONE,
  PRESENCE_TONE_GAIN,
  PRESENCE_TONE_PEAK_DBFS,
  READY_CHIME,
  SAMPLES_PER_FRAME,
  SILENCE_DBFS,
  peakDbfs,
  renderTone,
} from './pcm';

describe('peakDbfs', () => {
  it('reports digital silence as the floor, not -Infinity', () => {
    expect(peakDbfs(new Int16Array(SAMPLES_PER_FRAME))).toBe(SILENCE_DBFS);
  });

  it('reports full scale as 0 dBFS and half scale as about -6 dBFS', () => {
    expect(peakDbfs(Int16Array.of(0, -32768))).toBeCloseTo(0, 5);
    expect(peakDbfs(Int16Array.of(16384))).toBeCloseTo(-6.02, 1);
  });
});

describe('renderTone', () => {
  it('produces whole 20 ms frames covering the requested duration', () => {
    const frames = renderTone(READY_CHIME);
    expect(frames.every((f) => f.length === SAMPLES_PER_FRAME)).toBe(true);
    expect(frames.length).toBe(Math.ceil((320 * 48) / SAMPLES_PER_FRAME));
  });

  it('respects the gain and fades in from silence', () => {
    const [first, second] = renderTone([{ frequencyHz: 440, durationMs: 100 }], 0.25);
    expect(first?.[0]).toBe(0);
    expect(peakDbfs(second!)).toBeCloseTo(20 * Math.log10(0.25), 0);
  });

  it('renders a rest segment as silence', () => {
    const frames = renderTone([{ frequencyHz: 0, durationMs: 40 }]);
    expect(frames.map(peakDbfs)).toEqual([SILENCE_DBFS, SILENCE_DBFS]);
  });
});

describe('presence tone (ADR-028)', () => {
  it('is about 150 ms of two notes, peaking near -24 dBFS', () => {
    expect(PRESENCE_TONE.reduce((ms, segment) => ms + segment.durationMs, 0)).toBe(150);
    expect(PRESENCE_TONE.filter((segment) => segment.frequencyHz > 0)).toHaveLength(2);
    const frames = renderTone(PRESENCE_TONE, PRESENCE_TONE_GAIN);
    expect(frames).toHaveLength(Math.ceil((150 * 48) / SAMPLES_PER_FRAME));
    const peak = Math.max(...frames.map(peakDbfs));
    expect(peak).toBeLessThanOrEqual(PRESENCE_TONE_PEAK_DBFS + 0.1);
    expect(peak).toBeGreaterThan(PRESENCE_TONE_PEAK_DBFS - 1);
  });
});

describe('FrameDelay', () => {
  const frame = (n: number) => Int16Array.of(n);

  it('returns each frame after the configured number of pushes', () => {
    const delay = new FrameDelay(2);
    expect(delay.push(frame(1))).toBeUndefined();
    expect(delay.push(frame(2))).toBeUndefined();
    expect(delay.push(frame(3))).toEqual(frame(1));
    expect(delay.push(frame(4))).toEqual(frame(2));
  });

  it('passes frames straight through with zero delay', () => {
    expect(new FrameDelay(0).push(frame(7))).toEqual(frame(7));
  });

  it('forgets queued audio when cleared', () => {
    const delay = new FrameDelay(1);
    delay.push(frame(1));
    delay.clear();
    expect(delay.push(frame(2))).toBeUndefined();
  });

  it('rejects invalid delays', () => {
    expect(() => new FrameDelay(-1)).toThrow(RangeError);
  });
});
