import { SAMPLES_PER_FRAME } from './pcm';

/**
 * 48 kHz → 16 kHz decimator for speech recognition. A windowed-sinc low-pass (cutoff 7 kHz)
 * removes content that would alias, then every third sample is kept. Stateful across calls, so
 * 20 ms frames can be pushed one at a time without clicks at frame edges.
 */
const FACTOR = 3;
const TAPS = 47;

function lowPassTaps(): Float64Array {
  const cutoff = 7000 / 48_000; // normalized to the input rate
  const taps = new Float64Array(TAPS);
  const mid = (TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < TAPS; i += 1) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const blackman =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1));
    taps[i] = sinc * blackman;
    sum += taps[i]!;
  }
  for (let i = 0; i < TAPS; i += 1) taps[i]! /= sum; // unity gain at DC
  return taps;
}

const COEFFICIENTS = lowPassTaps();

export class Downsampler48To16 {
  /** Last TAPS-1 input samples, so the filter spans frame boundaries. */
  private history = new Float64Array(TAPS - 1);
  /** Input samples to skip before the next kept output, carried across calls. */
  private phase = 0;

  process(input: Int16Array): Int16Array {
    const buffer = new Float64Array(this.history.length + input.length);
    buffer.set(this.history);
    for (let i = 0; i < input.length; i += 1) buffer[this.history.length + i] = input[i]!;

    const out: number[] = [];
    // Output sample k is centred at buffer index (TAPS-1) + position of the kept input sample.
    for (let i = this.phase; i < input.length; i += FACTOR) {
      let acc = 0;
      const end = i + TAPS - 1; // index into buffer of the newest sample for this output
      for (let t = 0; t < TAPS; t += 1) acc += COEFFICIENTS[t]! * buffer[end - t]!;
      out.push(Math.max(-32768, Math.min(32767, Math.round(acc))));
    }
    const consumed = input.length - this.phase;
    this.phase = (FACTOR - (consumed % FACTOR)) % FACTOR;
    this.history = buffer.slice(buffer.length - (TAPS - 1));
    return Int16Array.from(out);
  }

  reset(): void {
    this.history.fill(0);
    this.phase = 0;
  }
}

/**
 * Re-slices a stream of arbitrarily sized PCM chunks (TTS output) into exact 20 ms, 48 kHz frames,
 * the unit the gateway publishes to LiveKit. Accepts little-endian 16-bit bytes, which is what
 * the provider sends over the wire; an odd trailing byte is kept for the next chunk.
 */
export class FrameAssembler {
  private pending = new Int16Array(0);
  private strayByte: number | undefined;

  push(bytes: Uint8Array): Int16Array[] {
    let data = bytes;
    if (this.strayByte !== undefined) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.strayByte;
      joined.set(bytes, 1);
      data = joined;
      this.strayByte = undefined;
    }
    if (data.length % 2 === 1) {
      this.strayByte = data[data.length - 1];
      data = data.subarray(0, data.length - 1);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const samples = new Int16Array(data.length / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true);

    const combined = new Int16Array(this.pending.length + samples.length);
    combined.set(this.pending);
    combined.set(samples, this.pending.length);

    const frames: Int16Array[] = [];
    let offset = 0;
    while (combined.length - offset >= SAMPLES_PER_FRAME) {
      frames.push(combined.slice(offset, offset + SAMPLES_PER_FRAME));
      offset += SAMPLES_PER_FRAME;
    }
    this.pending = combined.slice(offset);
    return frames;
  }

  /** Emits the remainder zero-padded to a full frame (end of an utterance), or nothing. */
  flush(): Int16Array[] {
    if (this.pending.length === 0) return [];
    const frame = new Int16Array(SAMPLES_PER_FRAME);
    frame.set(this.pending);
    this.pending = new Int16Array(0);
    this.strayByte = undefined;
    return [frame];
  }

  /** Samples held back waiting to fill a frame. */
  get pendingSamples(): number {
    return this.pending.length;
  }

  /** Drops buffered audio (cancelled speech). */
  clear(): void {
    this.pending = new Int16Array(0);
    this.strayByte = undefined;
  }
}
