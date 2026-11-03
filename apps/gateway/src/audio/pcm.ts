/**
 * Plain PCM helpers for the gateway's test audio. Mono, signed 16-bit, 48 kHz, 20 ms frames:
 * the format LiveKit/WebRTC uses natively, so no resampling is needed.
 */
export const SAMPLE_RATE = 48_000;
export const FRAME_MS = 20;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;

/** Quietest level reported, so digital silence still yields a finite number. */
export const SILENCE_DBFS = -120;

/** Peak level of one frame in dBFS (0 = full scale). */
export function peakDbfs(samples: Int16Array): number {
  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  if (peak === 0) return SILENCE_DBFS;
  return Math.max(SILENCE_DBFS, 20 * Math.log10(peak / 32768));
}

export interface ToneSegment {
  frequencyHz: number;
  durationMs: number;
}

/**
 * Renders tone segments into 20 ms frames with a short fade at each edge so segments don't click.
 * `gain` is linear amplitude relative to full scale.
 */
export function renderTone(segments: readonly ToneSegment[], gain = 0.2): Int16Array[] {
  const fadeSamples = Math.round(SAMPLE_RATE * 0.005);
  const samples: number[] = [];
  for (const { frequencyHz, durationMs } of segments) {
    const count = Math.round((SAMPLE_RATE * durationMs) / 1000);
    for (let i = 0; i < count; i += 1) {
      const envelope = Math.min(1, i / fadeSamples, (count - 1 - i) / fadeSamples);
      const value = frequencyHz === 0 ? 0 : Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE);
      samples.push(Math.round(value * envelope * gain * 32767));
    }
  }
  const frames: Int16Array[] = [];
  for (let offset = 0; offset < samples.length; offset += SAMPLES_PER_FRAME) {
    const frame = new Int16Array(SAMPLES_PER_FRAME); // zero-padded tail
    frame.set(samples.slice(offset, offset + SAMPLES_PER_FRAME));
    frames.push(frame);
  }
  return frames;
}

/** Rising two-note chime played when the gateway is ready and the caller can hear it. */
export const READY_CHIME: readonly ToneSegment[] = [
  { frequencyHz: 660, durationMs: 120 },
  { frequencyHz: 0, durationMs: 40 },
  { frequencyHz: 880, durationMs: 160 },
];

/**
 * The soft "heard you" tone (ADR-028): two gentle notes, 150 ms in all, played once when a
 * committed turn gets no agent text quickly. Generated here; no asset file.
 */
export const PRESENCE_TONE: readonly ToneSegment[] = [
  { frequencyHz: 587, durationMs: 60 },
  { frequencyHz: 0, durationMs: 15 },
  { frequencyHz: 784, durationMs: 75 },
];
/** Peak level of the presence tone: quiet, well under speech. */
export const PRESENCE_TONE_PEAK_DBFS = -24;
/** Linear gain that puts the presence tone's peak at PRESENCE_TONE_PEAK_DBFS. */
export const PRESENCE_TONE_GAIN = 10 ** (PRESENCE_TONE_PEAK_DBFS / 20);

/**
 * Fixed-length delay line for the echo test: each pushed frame comes back out `delayFrames`
 * pushes later. The delay makes the echo distinguishable from local sidetone on a real phone.
 */
export class FrameDelay {
  private readonly queue: Int16Array[] = [];

  constructor(private readonly delayFrames: number) {
    if (!Number.isInteger(delayFrames) || delayFrames < 0) {
      throw new RangeError('delayFrames must be a non-negative integer');
    }
  }

  /** Returns the frame that has waited long enough, or undefined while the line is filling. */
  push(frame: Int16Array): Int16Array | undefined {
    this.queue.push(frame);
    return this.queue.length > this.delayFrames ? this.queue.shift() : undefined;
  }

  clear(): void {
    this.queue.length = 0;
  }
}
