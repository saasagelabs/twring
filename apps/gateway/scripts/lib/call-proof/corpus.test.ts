import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadClips, loadCorpus, readRecordings, trimSilence } from './corpus';
import { readWav, writeWav } from './wav';

const corpusPath = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'test-fixtures',
  'speech',
  'corpus.json',
);

describe('corpus.json', () => {
  const corpus = loadCorpus(corpusPath);

  it('has about 40 lines, a quick set of about 6, and the lines the proof needs', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(38);
    expect(corpus.filter((u) => u.quick).length).toBe(6);
    const ids = corpus.map((u) => u.id);
    expect(ids).toContain('u28-long-pause'); // the barge-in line
    expect(ids).toContain('u23-stop');
    const terms = corpus.flatMap((u) => u.keyTerms.map((t) => t.toLowerCase()));
    for (const word of ['twring', 'saasage', 'rishflips', 'hermes', 'claude', 'codex']) {
      expect(terms).toContain(word);
    }
    for (const word of ['bye for now', 'wait', 'stop', 'hold on', 'hang on', 'one second']) {
      expect(terms).toContain(word);
    }
  });
});

describe('wav', () => {
  it('round-trips mono 16-bit PCM and averages stereo', () => {
    const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
    expect(readWav(writeWav(samples, 16_000))).toEqual({ rate: 16_000, samples });
    const stereo = writeWav(Int16Array.from([100, 300, -100, -300]), 48_000);
    // Rewrite the header as 2 channels holding 2 frames.
    const view = new DataView(stereo.buffer);
    view.setUint16(22, 2, true);
    expect(readWav(stereo).samples).toEqual(Int16Array.from([200, -200]));
  });

  it('refuses anything that is not a WAV', () => {
    expect(() => readWav(new Uint8Array(40))).toThrow(/not a WAV/);
  });
});

describe('clips', () => {
  it('trims silence around speech, keeping 20 ms', () => {
    const samples = new Int16Array(48_000);
    samples.fill(5000, 10_000, 20_000);
    expect(trimSilence(samples).length).toBe(10_000 + 2 * 960);
  });

  it('prefers recordings, voices the rest once, then reads the cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proof-'));
    const recordingsDir = join(dir, 'rec');
    mkdirSync(join(recordingsDir, 'ana'), { recursive: true });
    const speech = new Int16Array(1600).fill(4000);
    writeFileSync(join(recordingsDir, 'a.wav'), writeWav(speech, 16_000));
    writeFileSync(join(recordingsDir, 'ana', 'a.wav'), writeWav(speech, 48_000));
    const recordings = readRecordings(recordingsDir);
    expect([...recordings.keys()].sort()).toEqual(['ana', 'owner']);

    const utterances = [
      { id: 'a', text: 'hello', keyTerms: [] },
      { id: 'b', text: 'one two', keyTerms: [], parts: ['one', 'two'], pauseMs: 100 },
    ];
    const synthesize = vi.fn(() => Promise.resolve(new Int16Array(480).fill(3000)));
    const options = {
      utterances,
      recordings,
      voices: ['v1'],
      cacheDir: join(dir, 'cache'),
      synthesize,
    };
    const clips = await loadClips(options);
    expect(clips.map((c) => `${c.utterance.id}/${c.voice}`).sort()).toEqual([
      'a/ana',
      'a/owner',
      'b/v1',
    ]);
    expect(synthesize).toHaveBeenCalledTimes(2); // the two parts of b
    const b = clips.find((c) => c.utterance.id === 'b')!;
    expect(b.samples.length).toBe(480 + 4800 + 480);
    await loadClips(options);
    expect(synthesize).toHaveBeenCalledTimes(2); // cached
  });
});
