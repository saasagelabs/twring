/** Minimal PCM WAV reading and writing for the call proof's recordings and cache. */

export interface Wav {
  rate: number;
  /** Mono samples (stereo is averaged). */
  samples: Int16Array;
}

/** Reads 16-bit PCM WAV, mono or stereo; anything else is refused with a reason. */
export function readWav(bytes: Uint8Array): Wav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV');
  let offset = 12;
  let format: { channels: number; rate: number; bits: number; code: number } | undefined;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        code: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (format === undefined) throw new Error('WAV data before format');
      // 1 = PCM, 0xfffe = extensible (PCM in practice for 16-bit recorders).
      if ((format.code !== 1 && format.code !== 0xfffe) || format.bits !== 16) {
        throw new Error('WAV must be 16-bit PCM');
      }
      if (format.channels < 1 || format.channels > 2) throw new Error('WAV must be mono or stereo');
      const frames = Math.floor(Math.min(size, bytes.length - body) / (2 * format.channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i += 1) {
        let sum = 0;
        for (let c = 0; c < format.channels; c += 1) {
          sum += view.getInt16(body + (i * format.channels + c) * 2, true);
        }
        samples[i] = Math.round(sum / format.channels);
      }
      return { rate: format.rate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV has no data');
}

/** 16-bit mono PCM WAV. */
export function writeWav(samples: Int16Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const put = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  put(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  put(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(44 + i * 2, samples[i]!, true);
  return bytes;
}
