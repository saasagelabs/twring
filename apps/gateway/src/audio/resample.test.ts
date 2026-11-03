import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE, SAMPLES_PER_FRAME } from './pcm';
import { Downsampler48To16, FrameAssembler } from './resample';

function sine(frequencyHz: number, samples: number, amplitude = 10_000): Int16Array {
  return Int16Array.from({ length: samples }, (_, i) =>
    Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE)),
  );
}

function rms(samples: Int16Array, skip = 0): number {
  let sum = 0;
  for (let i = skip; i < samples.length; i += 1) sum += samples[i]! ** 2;
  return Math.sqrt(sum / (samples.length - skip));
}

function toBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return bytes;
}

describe('Downsampler48To16', () => {
  it('turns each 20 ms frame into 320 samples', () => {
    const down = new Downsampler48To16();
    expect(down.process(new Int16Array(SAMPLES_PER_FRAME))).toHaveLength(320);
  });

  it('passes speech-band audio at close to full level', () => {
    const out = new Downsampler48To16().process(sine(440, 4800));
    expect(rms(out, 50) / rms(sine(440, 4800))).toBeGreaterThan(0.95);
  });

  it('removes content above 8 kHz instead of aliasing it', () => {
    const out = new Downsampler48To16().process(sine(12_000, 4800));
    expect(rms(out, 50)).toBeLessThan(rms(sine(12_000, 4800)) * 0.01);
  });

  it('gives the same result whether audio arrives whole or in odd-sized pieces', () => {
    const input = sine(700, 4801);
    const whole = new Downsampler48To16().process(input);
    const chunked = new Downsampler48To16();
    const parts: number[] = [];
    for (let offset = 0; offset < input.length; offset += 961) {
      parts.push(...chunked.process(input.subarray(offset, offset + 961)));
    }
    expect(Int16Array.from(parts)).toEqual(whole);
  });
});

describe('FrameAssembler', () => {
  it('re-slices arbitrary byte chunks into exact 20 ms frames', () => {
    const assembler = new FrameAssembler();
    const source = sine(300, SAMPLES_PER_FRAME * 2 + 100);
    const bytes = toBytes(source);
    const frames = [
      ...assembler.push(bytes.subarray(0, 777)), // odd length: splits a sample
      ...assembler.push(bytes.subarray(777, 2501)),
      ...assembler.push(bytes.subarray(2501)),
    ];
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(source.subarray(0, SAMPLES_PER_FRAME));
    expect(frames[1]).toEqual(source.subarray(SAMPLES_PER_FRAME, SAMPLES_PER_FRAME * 2));

    const [tail] = assembler.flush();
    expect(tail).toHaveLength(SAMPLES_PER_FRAME);
    expect(tail!.subarray(0, 100)).toEqual(source.subarray(SAMPLES_PER_FRAME * 2));
    expect(tail!.subarray(100).every((s) => s === 0)).toBe(true);
    expect(assembler.flush()).toEqual([]);
  });

  it('forgets buffered audio when cleared', () => {
    const assembler = new FrameAssembler();
    assembler.push(toBytes(sine(300, 500)));
    assembler.clear();
    expect(assembler.flush()).toEqual([]);
  });
});
