/**
 * Per-call statistics of the caller's speech on the 16 kHz STT stream, for "it misheard me"
 * diagnosis: level (RMS and peak dBFS) and a narrowband indicator. Only frames whose peak is above
 * the speech gate count, so silence between turns does not drag the numbers down.
 *
 * Narrowband method: the 16 kHz stream runs through a 6th-order Butterworth high-pass at 4.5 kHz
 * (three cascaded biquads). `hf_ratio` is the high-passed energy divided by total energy, over
 * speech frames. Wideband speech keeps fricative energy up to the 7 kHz resampler cutoff; a caller
 * whose audio went through an 8 kHz path (Bluetooth SCO/HFP, a narrowband codec) has almost
 * nothing above 4 kHz, so the ratio collapses. The steep slope keeps a 300-3400 Hz band from
 * leaking into the measurement.
 *
 * O(1) state, no allocation per frame.
 */

const RATE = 16_000;
const HF_CUTOFF_HZ = 4_500;
/** Q of each section of a 6th-order Butterworth filter. */
const BUTTERWORTH_6_Q = [0.5176, 0.7071, 1.9319] as const;
const FULL_SCALE = 32_768;

/**
 * Below this `hf_ratio` the caller's audio is reported as narrowband. Band-limited 300-3400 Hz
 * signals measure under 0.001 and wideband speech-like signals over 0.02 (see speech-stats.test).
 * Provisional: recalibrate from real call logs.
 */
export const NARROWBAND_HF_RATIO = 0.003;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  z1: number;
  z2: number;
}

function highPass(q: number): Biquad {
  // RBJ cookbook high-pass.
  const w0 = (2 * Math.PI * HF_CUTOFF_HZ) / RATE;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
    z1: 0,
    z2: 0,
  };
}

function step(f: Biquad, x: number): number {
  // Transposed direct form II.
  const y = f.b0 * x + f.z1;
  f.z1 = f.b1 * x - f.a1 * y + f.z2;
  f.z2 = f.b2 * x - f.a2 * y;
  return y;
}

export interface SpeechAudioSummary {
  speech_rms_dbfs: number;
  speech_peak_dbfs: number;
  hf_ratio: number;
  narrowband: boolean;
}

export class SpeechStats {
  private readonly sections = BUTTERWORTH_6_Q.map(highPass);
  private readonly gate: number;
  private sumSq = 0;
  private hfSumSq = 0;
  private samples = 0;
  private peak = 0;

  /** `gateDbfs`: a frame counts as speech when its peak is above this. */
  constructor(gateDbfs: number) {
    this.gate = FULL_SCALE * 10 ** (gateDbfs / 20);
  }

  /** One chunk of 16 kHz mono audio. Every chunk runs through the filter, so its state stays continuous. */
  add(frame: Int16Array): void {
    const [s1, s2, s3] = this.sections as [Biquad, Biquad, Biquad];
    let sumSq = 0;
    let hfSumSq = 0;
    let peak = 0;
    for (let i = 0; i < frame.length; i += 1) {
      const x = frame[i]!;
      const hf = step(s3, step(s2, step(s1, x)));
      sumSq += x * x;
      hfSumSq += hf * hf;
      const abs = x < 0 ? -x : x;
      if (abs > peak) peak = abs;
    }
    if (peak <= this.gate) return;
    this.sumSq += sumSq;
    this.hfSumSq += hfSumSq;
    this.samples += frame.length;
    if (peak > this.peak) this.peak = peak;
  }

  /** Undefined until any speech frame arrived. */
  summary(): SpeechAudioSummary | undefined {
    if (this.samples === 0 || this.sumSq === 0) return undefined;
    const hfRatio = this.hfSumSq / this.sumSq;
    return {
      speech_rms_dbfs: round1(20 * Math.log10(Math.sqrt(this.sumSq / this.samples) / FULL_SCALE)),
      speech_peak_dbfs: round1(20 * Math.log10(this.peak / FULL_SCALE)),
      hf_ratio: Math.round(hfRatio * 10_000) / 10_000,
      narrowband: hfRatio < NARROWBAND_HF_RATIO,
    };
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
