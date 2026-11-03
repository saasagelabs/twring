/**
 * Replays a captured call (DEBUG_AUDIO_CAPTURE_DIR WAV, 16 kHz mono) through Deepgram Flux STT
 * configurations and prints each committed turn, to compare recognition on the same audio:
 *
 *   pnpm --filter @twring/gateway exec tsx --env-file-if-exists=.env scripts/stt-replay.ts <call.wav>
 *
 * Streams in real time (turn detection depends on timing). Uses Deepgram usage per config.
 */
import { readFileSync } from 'node:fs';

import { deepgramConfig, loadGatewayEnv } from '@twring/config/gateway';

import { createDeepgramStt } from '../src/voice/deepgram-stt';

const KEYTERMS = (process.env.REPLAY_KEYTERMS ?? '').split(',').filter((t) => t !== '');
const CONFIGS: { label: string; model: string; hints: string[]; keyterms: string[] }[] = [
  { label: 'flux-general-en', model: 'flux-general-en', hints: [], keyterms: [] },
  { label: 'flux-general-multi [en]', model: 'flux-general-multi', hints: ['en'], keyterms: [] },
  ...(KEYTERMS.length > 0
    ? [
        {
          label: `flux-general-en + keyterms ${KEYTERMS.join(',')}`,
          model: 'flux-general-en',
          hints: [],
          keyterms: KEYTERMS,
        },
        {
          label: `flux-general-multi [en] + keyterms ${KEYTERMS.join(',')}`,
          model: 'flux-general-multi',
          hints: ['en'],
          keyterms: KEYTERMS,
        },
      ]
    : []),
];

const path = process.argv[2];
const deepgram = deepgramConfig(loadGatewayEnv({ ...process.env, LOG_LEVEL: 'warn' }));
if (path === undefined || deepgram === undefined) {
  console.error('usage: stt-replay.ts <call.wav>  (needs DEEPGRAM_API_KEY)');
  process.exit(2);
}
const wav = readFileSync(path);
if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt32LE(24) !== 16_000) {
  console.error('expected a 16 kHz WAV written by DEBUG_AUDIO_CAPTURE_DIR');
  process.exit(2);
}
const audio = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function replay(config: (typeof CONFIGS)[number]): Promise<string[]> {
  const turns: string[] = [];
  const stt = createDeepgramStt({
    apiKey: deepgram!.apiKey,
    model: config.model,
    languageHints: config.hints,
    keyterms: config.keyterms,
  });
  const session = await stt.open((event) => {
    if (event.type === 'turn_ended') turns.push(event.text);
    if (event.type === 'error') turns.push(`<error ${event.error.code}>`);
  }, AbortSignal.timeout(10_000));
  const chunk = 320; // 20 ms
  const start = performance.now();
  for (let i = 0, n = 0; i < audio.length; i += chunk, n += 1) {
    session.sendAudio(audio.subarray(i, i + chunk));
    const wait = start + (n + 1) * 20 - performance.now();
    if (wait > 0) await sleep(wait);
  }
  for (let n = 0; n < 100; n += 1) {
    session.sendAudio(new Int16Array(chunk));
    await sleep(20);
  }
  await session.close();
  return turns;
}

console.log(`${path}: ${(audio.length / 16_000).toFixed(1)} s of audio`);
const results = await Promise.all(CONFIGS.map(async (c) => [c.label, await replay(c)] as const));
for (const [label, turns] of results) {
  console.log(`\n== ${label}`);
  turns.forEach((text, i) => console.log(`  ${i}: ${text}`));
}
