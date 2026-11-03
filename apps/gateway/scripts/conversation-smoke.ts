/**
 * Conversation loop check (Milestone 3 exit evidence), no phone or LiveKit needed:
 *
 *   pnpm --filter @twring/gateway run conversation:smoke
 *
 * Several spoken turns go through the real call path: Flux TTS voices the "caller", that audio is
 * streamed in real time through the call's own VoicePipeline to Flux STT, the committed turn goes
 * to the built-in fake agent, its streamed reply goes back through Flux TTS, and playout is paced
 * in real time as LiveKit would. Checks each turn's floor sequence, the reply, and latency:
 * first agent text → first TTS audio against OBSERVABILITY_AND_SLOS §3 (p95 < 800 ms).
 * Reads DEEPGRAM_API_KEY from apps/gateway/.env. Uses about a minute of Deepgram usage.
 */
import { FakeAgentAdapter } from '@twring/agent-adapter';
import { deepgramConfig, loadGatewayEnv } from '@twring/config/gateway';
import type { StatusMessage } from '@twring/contracts';

import { FRAME_MS, SAMPLE_RATE } from '../src/audio/pcm';
import { systemScheduler } from '../src/calls/scheduler';
import { ConversationController } from '../src/conversation/controller';
import { createDeepgramStt } from '../src/voice/deepgram-stt';
import { createDeepgramTts } from '../src/voice/deepgram-tts';
import { VoicePipeline } from '../src/voice/pipeline';

import { voiceLine } from './lib/voice';

const TURNS = [
  'Hello, can you hear me?',
  'Please search for the nearest coffee shop.',
  'What is the capital of France?',
];
const TEXT_TO_AUDIO_P95_MS = 800;
const TURN_TIMEOUT_MS = 30_000;

const env = loadGatewayEnv({ ...process.env, LOG_LEVEL: 'warn' });
const deepgram = deepgramConfig(env);
if (deepgram === undefined) {
  console.error('Set DEEPGRAM_API_KEY in apps/gateway/.env');
  process.exit(2);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) =>
  checks.push({ name, ok, ...(detail !== undefined && { detail }) });

/** Voices the caller's line with Flux TTS; returns 48 kHz samples. */
const voice = (text: string): Promise<Int16Array> => voiceLine(deepgram, text);

// Telemetry: the pipeline and controller log structured events; keep the ones we measure.
const events: Record<string, unknown>[] = [];
const logger = {
  info: (fields: Record<string, unknown>) => events.push(fields),
  warn: (fields: Record<string, unknown>) => events.push({ ...fields, level: 'warn' }),
};
const sent: StatusMessage[] = [];

// Real-time playout model: frames play back to back from when they are queued.
let playoutEndsAt = 0;
const timers = new Set<NodeJS.Timeout>();
const at = (time: number, callback: () => void) => {
  const handle = setTimeout(
    () => {
      timers.delete(handle);
      callback();
    },
    Math.max(0, time - performance.now()),
  );
  timers.add(handle);
};

const pipeline: VoicePipeline = new VoicePipeline({
  callId: 'smoke',
  stt: createDeepgramStt({
    apiKey: deepgram.apiKey,
    model: deepgram.sttModel,
    keyterms: deepgram.sttKeyterms,
    eotThreshold: deepgram.sttEotThreshold,
    eotTimeoutMs: deepgram.sttEotTimeoutMs,
  }),
  tts: createDeepgramTts({ apiKey: deepgram.apiKey, model: deepgram.ttsModel }),
  scheduler: systemScheduler,
  logger,
  onUserSpeechStarted: () => conversation.userSpeechStarted(),
  onUserSpeechDiscarded: () => conversation.userSpeechDiscarded(),
  onUserPartial: (text) => conversation.userPartial(text),
  onUserTurn: (text) => conversation.userTurn(text),
  onCaption: () => undefined,
  onSpeech: ({ generationId, state }) => conversation.speechState(generationId, state),
  playFrames: (frames, { onFirstPublished, onLastPublished, onDone }) => {
    const start = Math.max(performance.now(), playoutEndsAt);
    playoutEndsAt = start + frames.length * FRAME_MS;
    if (frames.length > 0 && onFirstPublished) at(start, onFirstPublished);
    if (frames.length > 0 && onLastPublished) at(playoutEndsAt, onLastPublished);
    if (onDone) at(playoutEndsAt, onDone);
  },
  stopPlayback: () => {
    const dropped = Math.max(0, Math.round((playoutEndsAt - performance.now()) / FRAME_MS));
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
    playoutEndsAt = 0;
    return dropped;
  },
  onFatal: (error) => console.error(`voice failed: ${error.code}`),
});
const conversation = new ConversationController({
  callId: 'smoke',
  adapter: new FakeAgentAdapter(),
  speech: {
    begin: (committedAt) => pipeline.beginSpeech(committedAt),
    append: (id, text) => pipeline.appendSpeech(id, text),
    end: (id) => pipeline.endSpeech(id),
    cancel: (reason) => pipeline.cancelSpeech(reason),
    callerOnsetAt: () => pipeline.callerOnsetAt(),
    playedMs: (id) => pipeline.playedMs(id),
    totalAudioMs: (id) => pipeline.totalAudioMs(id),
  },
  scheduler: systemScheduler,
  logger,
  send: (message) => sent.push(message),
});

/** Streams caller audio in real time, then silence until the floor is back to listening. */
async function speakTurn(audio: Int16Array): Promise<void> {
  const frame = SAMPLE_RATE / 50;
  const silence = new Int16Array(frame);
  const start = performance.now();
  let index = 0;
  const pace = async () => {
    index += 1;
    const wait = start + index * FRAME_MS - performance.now();
    if (wait > 0) await sleep(wait);
  };
  for (let offset = 0; offset < audio.length; offset += frame) {
    pipeline.pushCallerAudio(audio.subarray(offset, offset + frame));
    await pace();
  }
  const deadline = performance.now() + TURN_TIMEOUT_MS;
  const floorsBefore = sent.filter((m) => m.type === 'floor').length;
  for (;;) {
    pipeline.pushCallerAudio(silence); // the caller's line stays open, as on a call
    await pace();
    const floors = sent.filter((m) => m.type === 'floor').slice(floorsBefore);
    if (
      floors.at(-1)?.type === 'floor' &&
      floors.length > 1 &&
      floors.at(-1)!.floor === 'listening'
    ) {
      return;
    }
    if (performance.now() > deadline) throw new Error('turn did not complete');
  }
}

const field = (name: string, key: string, turn: number) => {
  const matching = events.filter((e) => e.event === name);
  return matching[turn]?.[key] as number | undefined;
};

try {
  const lines = await Promise.all(TURNS.map(voice));
  await Promise.all([pipeline.start(), conversation.connect(AbortSignal.timeout(5000))]);
  for (const [n, audio] of lines.entries()) {
    const from = sent.length;
    await speakTurn(audio);
    const messages = sent.slice(from);
    const floors = messages.flatMap((m) =>
      m.type === 'floor' ? [m.floor + (m.activity ? `(${m.activity})` : '')] : [],
    );
    const reply = messages.filter((m) => m.type === 'agent_text').at(-1);
    const expected = n === 1 ? 'agent_working(Looking that up…)' : undefined;
    check(
      `turn ${n + 1}: floor went caller → agent working → speaking → listening`,
      floors[0] === 'user_speaking' &&
        floors.includes('agent_working') &&
        floors.includes('agent_speaking') &&
        floors.at(-1) === 'listening' &&
        (expected === undefined || floors.includes(expected)),
      floors.join(' → '),
    );
    check(
      `turn ${n + 1}: streamed reply finished`,
      reply?.type === 'agent_text' && reply.final && reply.text.length > 0,
      reply?.type === 'agent_text' ? `"${reply.text.slice(0, 80)}"` : 'no reply',
    );
  }
  const textToAudio = TURNS.map((_, n) => field('tts_first_audio', 'after_text_ms', n) ?? Infinity);
  const commitToAudio = TURNS.map((_, n) => field('audio_first_published', 'duration_ms', n));
  const agentFirstText = TURNS.map((_, n) => field('agent_first_text', 'duration_ms', n));
  check(
    'first agent text → first TTS audio within p95 budget on every turn',
    textToAudio.every((ms) => ms <= TEXT_TO_AUDIO_P95_MS),
    `${textToAudio.join(', ')} ms`,
  );
  console.log(
    JSON.stringify(
      {
        timings: {
          agent_first_text_ms: agentFirstText,
          text_to_first_audio_ms: textToAudio,
          commit_to_audio_published_ms: commitToAudio,
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  check('conversation loop', false, error instanceof Error ? error.message : 'unknown error');
} finally {
  conversation.close();
  await pipeline.close();
}
const warnings = events.filter((e) => e.level === 'warn').map((e) => e.event);
check('no warnings logged', warnings.length === 0, warnings.join(', '));
const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ ok, checks }, null, 2));
process.exit(ok ? 0 : 1);
