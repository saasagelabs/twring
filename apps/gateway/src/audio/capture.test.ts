import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SttAudioCapture } from './capture';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SttAudioCapture', () => {
  it('writes a valid 16 kHz mono WAV and time-stamped captions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cord-capture-'));
    dirs.push(dir);
    const capture = new SttAudioCapture(dir, 'call_x');
    capture.write(Int16Array.of(1, -2, 3));
    capture.write(new Int16Array(15_997));
    capture.caption(0, 'hello there');
    capture.close();
    capture.close();
    capture.write(Int16Array.of(9)); // ignored after close

    const wav = readFileSync(join(dir, 'call_x.wav'));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(16_000 * 2);
    expect(wav.length).toBe(44 + 16_000 * 2);
    expect(wav.readInt16LE(46)).toBe(-2);
    expect(readFileSync(join(dir, 'call_x.txt'), 'utf8')).toBe('1.00s turn 0: hello there\n');
  });
});
