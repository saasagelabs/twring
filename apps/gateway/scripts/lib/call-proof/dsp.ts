/**
 * Listening conditions for the call proof, made from one clean 48 kHz clip in plain TypeScript:
 * a Bluetooth headset line (300 to 3400 Hz, 8 kHz sampling, as HFP's CVSD codec carries it),
 * that line with room noise, and a quiet caller. Offline only, so the filters favour clarity over
 * speed.
 */

export const RATE = 48_000;

/** Windowed-sinc (Blackman) low-pass taps; `cutoffHz` is the half-amplitude point. */
export function lowPassTaps(cutoffHz: number, rate: number, taps: number): Float64Array {
  const cutoff = cutoffHz / rate;
  const out = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i += 1) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const blackman =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    out[i] = sinc * blackman;
    sum += out[i]!;
  }
  for (let i = 0; i < taps; i += 1) out[i]! /= sum; // unity gain at DC
  return out;
}

/** High-pass by spectral inversion of a low-pass with the same cutoff (odd `taps`). */
export function highPassTaps(cutoffHz: number, rate: number, taps: number): Float64Array {
  const out = lowPassTaps(cutoffHz, rate, taps).map((t) => -t);
  out[(taps - 1) / 2]! += 1;
  return out;
}

/** Zero-phase-aligned FIR: output sample i is centred on input sample i (same length). */
export function convolve(input: Float64Array, taps: Float64Array): Float64Array {
  const out = new Float64Array(input.length);
  const mid = (taps.length - 1) / 2;
  for (let i = 0; i < input.length; i += 1) {
    let acc = 0;
    const from = Math.max(0, i - mid);
    const to = Math.min(input.length - 1, i + mid);
    for (let j = from; j <= to; j += 1) acc += input[j]! * taps[j - i + mid]!;
    out[i] = acc;
  }
  return out;
}

export function toFloat(samples: Int16Array): Float64Array {
  return Float64Array.from(samples, (s) => s / 32768);
}

export function toInt16(samples: Float64Array): Int16Array {
  return Int16Array.from(samples, (s) => Math.max(-32768, Math.min(32767, Math.round(s * 32768))));
}

/** FIR output at one input position (same centring as `convolve`). */
function firAt(input: Float64Array, taps: Float64Array, i: number): number {
  const mid = (taps.length - 1) / 2;
  let acc = 0;
  const from = Math.max(0, i - mid);
  const to = Math.min(input.length - 1, i + mid);
  for (let j = from; j <= to; j += 1) acc += input[j]! * taps[j - i + mid]!;
  return acc;
}

/**
 * Integer-factor decimation behind an anti-alias low-pass (default 90% of the new Nyquist); only
 * the kept samples are filtered.
 */
export function decimate(
  input: Float64Array,
  rate: number,
  factor: number,
  cutoffHz = (0.9 * rate) / factor / 2,
  taps = 255,
): Float64Array {
  if (factor === 1) return input;
  const filter = lowPassTaps(cutoffHz, rate, taps);
  const out = new Float64Array(Math.floor(input.length / factor));
  for (let i = 0; i < out.length; i += 1) out[i] = firAt(input, filter, i * factor);
  return out;
}

/**
 * Integer-factor interpolation: zero-stuffing and an image-rejection low-pass, computed per phase
 * so the stuffed zeros cost nothing.
 */
export function interpolate(input: Float64Array, rate: number, factor: number): Float64Array {
  if (factor === 1) return input;
  const filter = lowPassTaps(0.9 * (rate / 2), rate * factor, 255);
  const mid = (filter.length - 1) / 2;
  const out = new Float64Array(input.length * factor);
  for (let i = 0; i < out.length; i += 1) {
    // Stuffed position p = k * factor contributes input[k] * factor * filter[p - i + mid].
    const first = Math.max(0, Math.ceil((i - mid) / factor));
    const last = Math.min(input.length - 1, Math.floor((i + mid) / factor));
    let acc = 0;
    for (let k = first; k <= last; k += 1) acc += input[k]! * filter[k * factor - i + mid]!;
    out[i] = acc * factor;
  }
  return out;
}

/** Any supported recording rate to 48 kHz (rates that divide 48 kHz: 8, 12, 16, 24, 48 kHz). */
export function to48k(samples: Int16Array, rate: number): Int16Array {
  if (rate === RATE) return samples;
  if (RATE % rate !== 0) {
    throw new Error(`unsupported sample rate ${rate}: record at 48 kHz or 16 kHz`);
  }
  return toInt16(interpolate(toFloat(samples), rate, RATE / rate));
}

/**
 * A Bluetooth hands-free line: band-limit to 300 to 3400 Hz, sample at 8 kHz, and back up to
 * 48 kHz as the phone hands it to the app.
 */
export function narrowband(samples: Int16Array): Int16Array {
  const at8k = decimate(toFloat(samples), RATE, 6, 3400, 511);
  const band = convolve(at8k, highPassTaps(300, 8000, 101));
  return toInt16(interpolate(band, 8000, 6));
}

/** Seeded PRNG (mulberry32), so a condition sounds the same on every run. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RMS of the samples louder than -50 dBFS (the speech, not the silence around it). */
export function speechRms(samples: Float64Array): number {
  const floor = 10 ** (-50 / 20);
  let sum = 0;
  let n = 0;
  for (const s of samples) {
    if (Math.abs(s) < floor) continue;
    sum += s * s;
    n += 1;
  }
  return n === 0 ? 0 : Math.sqrt(sum / n);
}

export function rms(samples: Float64Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
}

/**
 * Adds noise at `snrDb` below the speech level: white noise shaped by a one-pole low-pass, close
 * to the hum and chatter of a room. Seeded, so it is the same noise on every run.
 */
export function addNoise(samples: Int16Array, snrDb: number, seed = 1): Int16Array {
  const clean = toFloat(samples);
  const next = random(seed);
  const noise = new Float64Array(clean.length);
  let smooth = 0;
  for (let i = 0; i < noise.length; i += 1) {
    // Box-Muller: a Gaussian sample.
    const g = Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next());
    smooth = 0.7 * smooth + 0.3 * g;
    noise[i] = smooth;
  }
  const scale = speechRms(clean) / (rms(noise) || 1) / 10 ** (snrDb / 20);
  for (let i = 0; i < clean.length; i += 1) clean[i]! += noise[i]! * scale;
  return toInt16(clean);
}

/** Changes the level by `db` (negative is quieter). */
export function gain(samples: Int16Array, db: number): Int16Array {
  const factor = 10 ** (db / 20);
  return toInt16(toFloat(samples).map((s) => s * factor));
}

export type ConditionName = 'clean' | 'narrowband' | 'narrowband_noise' | 'quiet';
export const CONDITIONS: readonly ConditionName[] = [
  'clean',
  'narrowband',
  'narrowband_noise',
  'quiet',
];

/** One clean 48 kHz clip as the caller would sound in `condition`. */
export function applyCondition(clip: Int16Array, condition: ConditionName, seed = 1): Int16Array {
  switch (condition) {
    case 'clean':
      return clip;
    case 'narrowband':
      return narrowband(clip);
    case 'narrowband_noise':
      return addNoise(narrowband(clip), 10, seed);
    case 'quiet':
      return gain(clip, -20);
  }
}

/** Power of one frequency in the signal (Goertzel), for tests and checks. */
export function tonePower(samples: Float64Array, rate: number, hz: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / rate);
  let s1 = 0;
  let s2 = 0;
  for (const x of samples) {
    const s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (samples.length * samples.length);
}
