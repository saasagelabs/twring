import { describe, expect, it } from 'vitest';

import {
  RATE,
  addNoise,
  applyCondition,
  gain,
  narrowband,
  speechRms,
  to48k,
  toFloat,
  tonePower,
} from './dsp';

function tones(hz: readonly number[], seconds = 0.5, rate = RATE, level = 0.2): Int16Array {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1) {
    let x = 0;
    for (const f of hz) x += Math.sin((2 * Math.PI * f * i) / rate);
    out[i] = Math.round((level / hz.length) * x * 32767);
  }
  return out;
}

const db = (ratio: number) => 10 * Math.log10(ratio);
/** The middle of a clip, away from filter edges. */
const middle = (s: Int16Array) => toFloat(s.subarray(s.length / 4, (3 * s.length) / 4));

describe('narrowband (Bluetooth HFP line)', () => {
  const input = tones([1000, 6000, 150]);
  const output = narrowband(input);

  it('keeps the length and the speech band', () => {
    expect(output.length).toBe(input.length);
    const kept = tonePower(middle(output), RATE, 1000) / tonePower(middle(input), RATE, 1000);
    expect(db(kept)).toBeGreaterThan(-1);
  });

  it('drops energy above 4 kHz', () => {
    const above = tonePower(middle(output), RATE, 6000) / tonePower(middle(input), RATE, 6000);
    expect(db(above)).toBeLessThan(-40);
  });

  it('drops energy below 300 Hz', () => {
    const below = tonePower(middle(output), RATE, 150) / tonePower(middle(input), RATE, 150);
    expect(db(below)).toBeLessThan(-10);
  });
});

describe('levels and noise', () => {
  it('gain -20 dB is a tenth of the amplitude', () => {
    const input = tones([1000]);
    const ratio = speechRms(toFloat(gain(input, -20))) / speechRms(toFloat(input));
    expect(ratio).toBeCloseTo(0.1, 2);
  });

  it('adds noise at the asked SNR, the same noise every run', () => {
    const input = tones([1000], 1);
    const noisy = addNoise(input, 10, 7);
    expect(addNoise(input, 10, 7)).toEqual(noisy);
    const clean = toFloat(input);
    const noise = toFloat(noisy).map((x, i) => x - clean[i]!);
    let pn = 0;
    let ps = 0;
    for (let i = 0; i < clean.length; i += 1) {
      pn += noise[i]! ** 2;
      ps += clean[i]! ** 2;
    }
    expect(db(ps / pn)).toBeGreaterThan(9);
    expect(db(ps / pn)).toBeLessThan(11);
  });

  it('clean is the clip untouched', () => {
    const input = tones([440]);
    expect(applyCondition(input, 'clean')).toBe(input);
  });
});

describe('to48k', () => {
  it('upsamples 16 kHz recordings keeping the tone', () => {
    const at16 = tones([1000], 0.5, 16_000);
    const up = to48k(at16, 16_000);
    expect(up.length).toBe(at16.length * 3);
    const power = tonePower(middle(up), RATE, 1000) / tonePower(middle(at16), 16_000, 1000);
    expect(db(power)).toBeGreaterThan(-1);
    expect(db(power)).toBeLessThan(1);
  });

  it('refuses rates that do not divide 48 kHz', () => {
    expect(() => to48k(new Int16Array(10), 44_100)).toThrow(/44100/);
  });
});
