/**
 * Deepgram round-trip check (Milestone 2 exit evidence), no phone or LiveKit needed:
 *
 *   pnpm --filter @twring/gateway run voice:smoke
 *
 * 1. Flux TTS speaks a known sentence; we time the first audio byte.
 * 2. That audio (48 kHz) is downsampled exactly as a live call does and streamed to Flux STT in
 *    real time, followed by silence; we time end-of-turn after the speech ends.
 * 3. The committed transcript must contain the sentence's key words, and end-of-turn must land
 *    within the p95 budget.
 * Reads DEEPGRAM_API_KEY from apps/gateway/.env. Uses a few seconds of Deepgram usage.
 */
import { deepgramConfig, loadGatewayEnv } from '@twring/config/gateway';

import { SAMPLE_RATE } from '../src/audio/pcm';
import { Downsampler48To16 } from '../src/audio/resample';
import { createDeepgramStt } from '../src/voice/deepgram-stt';
import { createDeepgramTts } from '../src/voice/deepgram-tts';
import type { SttEvent, TtsEvent } from '../src/voice/types';

// A conversational question: Flux ends turns on meaning, so a finished question commits within a
// few hundred ms, while an open-ended statement can take seconds by design.
const SENTENCE = 'Can you tell me what the weather will be like tomorrow?';
const KEY_WORDS = ['tell', 'weather', 'tomorrow'];
/** Speech end → committed turn budget (OBSERVABILITY_AND_SLOS §3: p50 < 450 ms, p95 < 900 ms). */
const END_OF_TURN_BUDGET_MS = 900;
const TIMEOUT_MS = 20_000;

const env = loadGatewayEnv({ ...process.env, LOG_LEVEL: 'warn' });
const deepgram = deepgramConfig(env);
if (deepgram === undefined) {
  console.error('Set DEEPGRAM_API_KEY in apps/gateway/.env');
  process.exit(2);
}

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const timings: Record<string, number> = {};
const check = (name: string, ok: boolean, detail?: string) =>
  checks.push({ name, ok, ...(detail !== undefined && { detail }) });
const signal = AbortSignal.timeout(TIMEOUT_MS);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function synthesize(): Promise<Int16Array> {
  const chunks: Uint8Array[] = [];
  let firstAudioAt = 0;
  const started = performance.now();
  const done = new Promise<void>((resolve, reject) => {
    const tts = createDeepgramTts({ apiKey: deepgram!.apiKey, model: deepgram!.ttsModel });
    const onEvent = (event: TtsEvent) => {
      if (event.type === 'audio') {
        if (firstAudioAt === 0) firstAudioAt = performance.now();
        chunks.push(event.bytes);
      } else if (event.type === 'done') {
        resolve();
      } else {
        reject(new Error(`tts ${event.error.code}`));
      }
    };
    tts
      .open(onEvent, signal)
      .then((session) => {
        timings.tts_connect_ms = Math.round(performance.now() - started);
        const sent = performance.now();
        session.speak('smoke', SENTENCE);
        session.flush('smoke');
        void done.finally(() => {
          timings.tts_first_audio_ms = Math.round(firstAudioAt - sent);
          timings.tts_total_ms = Math.round(performance.now() - sent);
          void session.close();
        });
      })
      .catch(reject);
  });
  await done;
  const bytes = Buffer.concat(chunks);
  const samples = new Int16Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readInt16LE(i * 2);
  return samples;
}

async function transcribe(audio48k: Int16Array): Promise<string> {
  const stt = createDeepgramStt({
    apiKey: deepgram!.apiKey,
    model: deepgram!.sttModel,
    eotThreshold: deepgram!.sttEotThreshold,
    eotTimeoutMs: deepgram!.sttEotTimeoutMs,
  });
  let resolveTurn!: (text: string) => void;
  const turn = new Promise<string>((resolve) => (resolveTurn = resolve));
  const partials: string[] = [];
  const onEvent = (event: SttEvent) => {
    if (event.type === 'partial') partials.push(event.text);
    if (event.type === 'turn_ended') resolveTurn(event.text);
    if (event.type === 'error') console.error(`stt error ${event.error.code}`);
  };
  const connectStarted = performance.now();
  const session = await stt.open(onEvent, signal);
  timings.stt_connect_ms = Math.round(performance.now() - connectStarted);

  // Stream like a live call: 20 ms frames at 48 kHz, downsampled, paced against the wall clock
  // (setTimeout alone drifts ~50% slow on Windows), then 3 s of silence.
  const down = new Downsampler48To16();
  const frame = SAMPLE_RATE / 50;
  const silence = new Int16Array(frame);
  const streamStart = performance.now();
  let speechEndedAt = 0;
  const pump = (async () => {
    let index = 0;
    const sendPaced = async (samples: Int16Array) => {
      session.sendAudio(down.process(samples));
      index += 1;
      const wait = streamStart + index * 20 - performance.now();
      if (wait > 0) await sleep(wait);
    };
    for (let offset = 0; offset < audio48k.length; offset += frame) {
      await sendPaced(audio48k.subarray(offset, offset + frame));
    }
    speechEndedAt = performance.now();
    for (let i = 0; i < 150; i += 1) await sendPaced(silence);
  })();
  const text = await Promise.race([
    turn,
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('no end of turn'))),
    ),
  ]);
  timings.stt_end_of_turn_after_speech_ms = Math.round(performance.now() - speechEndedAt);
  check('STT produced partial captions', partials.length > 0, `${partials.length} updates`);
  await session.close();
  void pump;
  return text;
}

try {
  const audio = await synthesize();
  const seconds = audio.length / SAMPLE_RATE;
  check('TTS returned speech audio', seconds > 1.5, `${seconds.toFixed(2)} s at 48 kHz`);
  const text = await transcribe(audio);
  const heard = text.toLowerCase();
  const missing = KEY_WORDS.filter((word) => !heard.includes(word));
  check('STT transcribed the TTS sentence', missing.length === 0, `"${text}"`);
  check(
    'turn committed within the p95 budget',
    (timings.stt_end_of_turn_after_speech_ms ?? Infinity) <= END_OF_TURN_BUDGET_MS,
    `${timings.stt_end_of_turn_after_speech_ms} ms after speech ended`,
  );
} catch (error) {
  check('voice round trip', false, error instanceof Error ? error.message : 'unknown error');
}
const ok = checks.length > 0 && checks.every((c) => c.ok);
console.log(JSON.stringify({ ok, checks, timings }, null, 2));
process.exit(ok ? 0 : 1);
