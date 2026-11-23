/**
 * The call proof's spoken lines (packages/test-fixtures/speech/corpus.json) and their audio:
 * the owner's recordings when a folder is given, else lines voiced by several Deepgram voices,
 * cached so a rerun costs no synthesis.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { RATE, to48k } from './dsp';
import { readWav, writeWav } from './wav';

const utteranceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  text: z.string().min(1),
  keyTerms: z.array(z.string().min(1)),
  /** In the post-deploy --quick set. */
  quick: z.boolean().optional(),
  /** False for floor-control words ("stop"), which the gateway answers with silence. */
  expectReply: z.boolean().optional(),
  /** Synthesized in these pieces with `pauseMs` of silence between (a caller pausing mid-thought). */
  parts: z.array(z.string().min(1)).optional(),
  pauseMs: z.number().int().positive().optional(),
});
export type Utterance = z.infer<typeof utteranceSchema>;

const corpusSchema = z.object({ version: z.literal(1), utterances: z.array(utteranceSchema) });

export function loadCorpus(path: string): Utterance[] {
  const corpus = corpusSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const ids = new Set<string>();
  for (const u of corpus.utterances) {
    if (ids.has(u.id)) throw new Error(`corpus: duplicate id ${u.id}`);
    ids.add(u.id);
  }
  return corpus.utterances;
}

/** One utterance as one voice says it, 48 kHz mono, leading and trailing silence trimmed. */
export interface Clip {
  utterance: Utterance;
  voice: string;
  samples: Int16Array;
}

/** Drops leading and trailing audio quieter than -50 dBFS, keeping 20 ms either side. */
export function trimSilence(samples: Int16Array): Int16Array {
  const floor = 32768 * 10 ** (-50 / 20);
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]!) < floor) start += 1;
  while (end > start && Math.abs(samples[end - 1]!) < floor) end -= 1;
  const pad = (RATE * 20) / 1000;
  return samples.slice(Math.max(0, start - pad), Math.min(samples.length, end + pad));
}

/**
 * Recordings in `dir`: `<id>.wav` is voice "owner"; `<speaker>/<id>.wav` is voice `<speaker>`.
 * Returns voice → id → samples.
 */
export function readRecordings(dir: string): Map<string, Map<string, Int16Array>> {
  const voices = new Map<string, Map<string, Int16Array>>();
  const add = (voice: string, file: string) => {
    if (!file.toLowerCase().endsWith('.wav')) return;
    const wav = readWav(readFileSync(file));
    const id = file.replace(/^.*[\\/]/, '').replace(/\.wav$/i, '');
    const clips = voices.get(voice) ?? new Map<string, Int16Array>();
    try {
      clips.set(id, trimSilence(to48k(wav.samples, wav.rate)));
    } catch (error) {
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    voices.set(voice, clips);
  };
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      for (const inner of readdirSync(path)) add(name, join(path, inner));
    } else add('owner', path);
  }
  return voices;
}

/** Rough speaking time of a line, for the cost estimate before anything is voiced. */
export function estimateSeconds(u: Utterance): number {
  const words = u.text.split(/\s+/).length;
  return words / 2.6 + 0.4 + (u.pauseMs ?? 0) / 1000;
}

/**
 * The clips for `utterances`: every recording found, and for lines with no recording, each of
 * `voices` synthesized by `synthesize` (cached as WAV under `cacheDir/<voice>/<id>.wav`).
 */
export async function loadClips(options: {
  utterances: readonly Utterance[];
  recordings?: Map<string, Map<string, Int16Array>>;
  voices: readonly string[];
  cacheDir: string;
  synthesize: (text: string, voice: string) => Promise<Int16Array>;
  onSynthesize?: (id: string, voice: string) => void;
}): Promise<Clip[]> {
  const clips: Clip[] = [];
  for (const utterance of options.utterances) {
    let recorded = false;
    for (const [voice, byId] of options.recordings ?? []) {
      const samples = byId.get(utterance.id);
      if (samples === undefined) continue;
      clips.push({ utterance, voice, samples });
      recorded = true;
    }
    if (recorded) continue;
    for (const voice of options.voices) {
      const file = join(options.cacheDir, voice, `${utterance.id}.wav`);
      if (existsSync(file)) {
        clips.push({ utterance, voice, samples: readWav(readFileSync(file)).samples });
        continue;
      }
      options.onSynthesize?.(utterance.id, voice);
      const pieces = utterance.parts ?? [utterance.text];
      const gap = new Int16Array(Math.round((RATE * (utterance.pauseMs ?? 0)) / 1000));
      const voiced: Int16Array[] = [];
      for (const [i, piece] of pieces.entries()) {
        if (i > 0) voiced.push(gap);
        voiced.push(trimSilence(await options.synthesize(piece, voice)));
      }
      const samples = new Int16Array(voiced.reduce((n, v) => n + v.length, 0));
      let at = 0;
      for (const v of voiced) {
        samples.set(v, at);
        at += v.length;
      }
      mkdirSync(join(options.cacheDir, voice), { recursive: true });
      writeFileSync(file, writeWav(samples, RATE));
      clips.push({ utterance, voice, samples });
    }
  }
  return clips;
}
