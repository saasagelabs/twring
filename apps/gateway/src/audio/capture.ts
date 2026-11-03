import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Development-only recorder for diagnosing speech recognition: the exact 16 kHz audio sent to STT
 * as a WAV file, plus committed captions with their audio time. Config refuses to enable it
 * outside development (DEBUG_AUDIO_CAPTURE_DIR), so production Twring never keeps call audio
 * (ADR-008).
 */
export class SttAudioCapture {
  private readonly wav: number;
  private readonly captions: number;
  private samples = 0;
  private closed = false;

  constructor(
    dir: string,
    callId: string,
    private readonly sampleRate = 16_000,
  ) {
    mkdirSync(dir, { recursive: true });
    this.wav = openSync(join(dir, `${callId}.wav`), 'w');
    this.captions = openSync(join(dir, `${callId}.txt`), 'w');
    writeSync(this.wav, this.header(0), 0, 44, 0);
  }

  write(samples: Int16Array): void {
    if (this.closed || samples.length === 0) return;
    const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    writeSync(this.wav, bytes, 0, bytes.length, 44 + this.samples * 2);
    this.samples += samples.length;
  }

  caption(turnIndex: number, text: string): void {
    if (this.closed) return;
    const at = (this.samples / this.sampleRate).toFixed(2);
    writeSync(this.captions, `${at}s turn ${turnIndex}: ${text}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    writeSync(this.wav, this.header(this.samples * 2), 0, 44, 0);
    closeSync(this.wav);
    closeSync(this.captions);
  }

  /** Canonical 44-byte PCM WAV header for 16-bit mono. */
  private header(dataBytes: number): Buffer {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + dataBytes, 4);
    h.write('WAVE', 8);
    h.write('fmt ', 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); // PCM
    h.writeUInt16LE(1, 22); // mono
    h.writeUInt32LE(this.sampleRate, 24);
    h.writeUInt32LE(this.sampleRate * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(dataBytes, 40);
    return h;
  }
}
