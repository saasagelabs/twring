/**
 * Call proof: does the gateway hear what callers say, on real phone-like audio?
 *
 *   pnpm --filter @twring/gateway call:proof [--quick] [--estimate] [--conditions clean,quiet]
 *     [--settings F|-] [--thresholds F] [--update-baseline] [--port 8098]
 *
 * Builds on the load test's harness (lib/harness.ts): a simulated phone joins a call through
 * LiveKit and speaks known lines in real time, each followed by silence as a caller would
 * (pipecat-ai/stt-benchmark). The gateway runs real Deepgram STT and TTS with the `repeat` test
 * agent, which says back exactly what it heard, so the final captions are the recognizer's output
 * (Pipecat evals: synthesized users through real STT). Each clip is played as recorded and as
 * a Bluetooth line, a noisy Bluetooth line and a quiet caller; known input, objective score on
 * output (jitsi-meet-torture). See packages/test-fixtures/speech/README.md.
 *
 * Gateway: the built dist/main.js started here on the test line, or CALL_PROOF_GATEWAY_URL (a
 * staging server running AUTH_MODE=dev and GATEWAY_AUDIO_TEST_MODE=repeat; its log is not read,
 * so gateway-side timings are left out). Never production. Exits 1 on a regression.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { deepgramConfig, loadGatewayEnv } from '@twring/config/gateway';
import { GATEWAY_IDENTITY, STATUS_TOPIC, captionMessageSchema } from '@twring/contracts';
import {
  AudioFrame,
  AudioStream,
  RoomEvent,
  TrackKind,
  dispose,
  type RemoteTrack,
} from '@livekit/rtc-node';

import { SAMPLE_RATE, SAMPLES_PER_FRAME, peakDbfs } from '../src/audio/pcm';

import {
  loadClips,
  loadCorpus,
  readRecordings,
  estimateSeconds,
  type Clip,
} from './lib/call-proof/corpus';
import { CONDITIONS, applyCondition, type ConditionName } from './lib/call-proof/dsp';
import {
  DEFAULT_THRESHOLDS,
  formatTable,
  judge,
  scoreCondition,
  type BargeIn,
  type ProofReport,
  type Thresholds,
  type UtteranceResult,
} from './lib/call-proof/score';
import {
  arg,
  isProduction,
  joinCall,
  now,
  readEnvFile,
  readGatewayLog,
  sleep,
  startGateway,
  testLineEnv,
  waitReady,
} from './lib/harness';
import { voiceLine } from './lib/voice';

const AUDIBLE_DBFS = -45;
/** Silence after each clip: the caller has finished and waits for the answer. */
const AFTER_SPEECH_MS = 1500;
/** A reply is over after this much quiet. */
const REPLY_END_SILENCE_MS = 1200;
/** Longest wait for a clip's turn and reply before moving on. */
const CLIP_TIMEOUT_MS = 20_000;
/** For clips with no reply (floor-control words): how long to wait for their caption. */
const NO_REPLY_WAIT_MS = 6000;
/** Deepgram Flux voices unlike the reply voice, so caller and agent are never the same voice. */
const DEFAULT_VOICES = ['flux-kit-en', 'flux-cliff-en', 'flux-priya-en'];
/** Deepgram's documented speaking rate is about 15 characters a second; for the estimate only. */
const TTS_CHARS_PER_SECOND = 15;

const flag = (name: string) => process.argv.includes(`--${name}`);
const quick = flag('quick');
const port = Number.parseInt(arg('port') ?? '8098', 10);
const gatewayPath = arg('gateway') ?? join(import.meta.dirname, '..', 'dist', 'main.js');
const workDir = join(import.meta.dirname, '..', '.call-proof');
const corpusPath = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'test-fixtures',
  'speech',
  'corpus.json',
);
const baselinePath = arg('baseline') ?? join(workDir, `baseline-${quick ? 'quick' : 'full'}.json`);

const envFile = arg('settings');
const baseEnv: Record<string, string | undefined> = {
  ...process.env,
  ...(envFile !== undefined && readEnvFile(envFile)),
};
const remote = baseEnv.CALL_PROOF_GATEWAY_URL;
if (isProduction(baseEnv) || (remote ?? '').includes('api.twring.com')) {
  console.error('Refusing to run the call proof against production. Use staging or local.');
  process.exit(2);
}
const childEnv = testLineEnv(baseEnv, port, 'repeat');
const deepgram = deepgramConfig(loadGatewayEnv(childEnv));
if (deepgram === undefined) {
  console.error('DEEPGRAM_API_KEY is needed to voice the callers and to hear them.');
  process.exit(2);
}
const base = remote ?? `http://127.0.0.1:${port}`;
const gatewayLog = join(childEnv.CORD_DATA_DIR!, 'gateway.log');

const conditions = (arg('conditions')?.split(',') ?? [...CONDITIONS]).filter(
  (c): c is ConditionName => (CONDITIONS as readonly string[]).includes(c),
);
const voices = (baseEnv.CALL_PROOF_VOICES ?? '')
  .split(',')
  .map((v) => v.trim())
  .filter((v) => v !== '');

function thresholds(): Thresholds {
  const file = arg('thresholds');
  if (file === undefined) return DEFAULT_THRESHOLDS;
  const custom = JSON.parse(readFileSync(file, 'utf8')) as Partial<Thresholds>;
  return {
    ...DEFAULT_THRESHOLDS,
    ...custom,
    minKeyTermRecall: { ...DEFAULT_THRESHOLDS.minKeyTermRecall, ...custom.minKeyTermRecall },
    maxWer: { ...DEFAULT_THRESHOLDS.maxWer, ...custom.maxWer },
  };
}

// --- one call per condition ----------------------------------------------------------------

interface Caption {
  turnIndex: number;
  text: string;
  at: number;
}

interface CallRun {
  results: UtteranceResult[];
  callId: string;
  bargeIn?: BargeIn & { quietAtEpochMs?: number };
}

async function runCondition(
  condition: ConditionName,
  clips: readonly Clip[],
  bargeIn?: { long: Clip; stop: Clip },
): Promise<CallRun> {
  const finals: Caption[] = [];
  let audibleAt: number[] = [];
  let gatewayTrack: RemoteTrack | undefined;
  let running = true;
  const user = `proof-${condition}-${Date.now()}`;
  const headers: Record<string, string> =
    baseEnv.CALL_PROOF_BEARER === undefined
      ? { 'x-cord-dev-user': user }
      : { authorization: `Bearer ${baseEnv.CALL_PROOF_BEARER}` };
  const joined = await joinCall(base, headers, (room) => {
    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic !== STATUS_TOPIC) return;
      try {
        const parsed = captionMessageSchema.safeParse(
          JSON.parse(new TextDecoder().decode(payload)),
        );
        if (parsed.success && parsed.data.final) {
          finals.push({ turnIndex: parsed.data.turn_index, text: parsed.data.text, at: now() });
        }
      } catch {
        // Not JSON: not a caption.
      }
    });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
      if (participant.identity === GATEWAY_IDENTITY && track.kind === TrackKind.KIND_AUDIO) {
        gatewayTrack = track;
      }
    });
  });
  if (!joined.ok) throw new Error(`${condition}: could not join a call (${joined.reason})`);
  const { call, source } = joined.phone;

  // The speaker: times of audible frames from the gateway, read as they arrive.
  const listen = (track: RemoteTrack) =>
    void (async () => {
      for await (const frame of new AudioStream(track, {
        sampleRate: SAMPLE_RATE,
        numChannels: 1,
      })) {
        if (!running) break;
        if (peakDbfs(frame.data) > AUDIBLE_DBFS) audibleAt.push(now());
      }
    })();
  const trackWait = now();
  while (gatewayTrack === undefined && now() - trackWait < 5000) await sleep(50);
  if (gatewayTrack !== undefined) listen(gatewayTrack);

  // The microphone: plays `samples` in real time; resolves at the end of the speech as it leaves.
  const silence = new Int16Array(SAMPLES_PER_FRAME);
  let queue: Int16Array | undefined;
  let spoken: ((endAt: number) => void) | undefined;
  const mic = (async () => {
    while (running) {
      const line = queue;
      if (line === undefined) {
        await source.captureFrame(new AudioFrame(silence, SAMPLE_RATE, 1, SAMPLES_PER_FRAME));
        continue;
      }
      for (let offset = 0; offset < line.length && running; offset += SAMPLES_PER_FRAME) {
        const frame = new Int16Array(SAMPLES_PER_FRAME);
        frame.set(line.subarray(offset, offset + SAMPLES_PER_FRAME));
        await source.captureFrame(new AudioFrame(frame, SAMPLE_RATE, 1, SAMPLES_PER_FRAME));
      }
      queue = undefined;
      spoken?.(now() + source.queuedDuration);
    }
  })();
  const say = (samples: Int16Array): Promise<number> => {
    const done = new Promise<number>((resolve) => (spoken = resolve));
    queue = samples;
    return done;
  };
  const quietSince = (from: number) => {
    const last = audibleAt.filter((t) => t >= from).at(-1);
    return now() - (last ?? from);
  };

  const results: UtteranceResult[] = [];
  let bargeResult: CallRun['bargeIn'];
  try {
    await sleep(2500); // the ready chime
    for (const clip of clips) {
      audibleAt = [];
      const firstFinal = finals.length;
      const startAt = now();
      const endAt = await say(applyCondition(clip.samples, condition));
      const expectReply = clip.utterance.expectReply ?? true;
      // Wait for the answer to start and finish, or (no answer expected) for the caption.
      for (;;) {
        await sleep(100);
        const waited = now() - endAt;
        if (now() - startAt > CLIP_TIMEOUT_MS + clip.samples.length / 48) break;
        const heard = audibleAt.some((t) => t > endAt);
        if (expectReply && heard && quietSince(endAt) > REPLY_END_SILENCE_MS) break;
        if (!expectReply && waited > NO_REPLY_WAIT_MS) break;
      }
      await sleep(AFTER_SPEECH_MS);
      const mine = finals.slice(firstFinal);
      const committedAt = mine[0]?.at;
      results.push({
        id: clip.utterance.id,
        condition,
        voice: clip.voice,
        reference: clip.utterance.text,
        keyTerms: clip.utterance.keyTerms,
        hypothesis: mine.map((c) => c.text).join(' '),
        commits: mine.length,
        ...(committedAt !== undefined && { commitMs: Math.max(0, committedAt - endAt) }),
        expectReply,
        replyHeard: audibleAt.some((t) => t > endAt),
      });
      process.stderr.write('.');
    }
    if (bargeIn !== undefined) bargeResult = await runBargeIn(bargeIn);
  } finally {
    running = false;
    await mic.catch(() => undefined);
    await joined.phone.hangUp();
  }
  return {
    results,
    callId: call.call_id,
    ...(bargeResult !== undefined && { bargeIn: bargeResult }),
  };

  /** Says a long line, then "stop" one second into its reply; times how fast the reply stops. */
  async function runBargeIn(lines: { long: Clip; stop: Clip }): Promise<CallRun['bargeIn']> {
    audibleAt = [];
    const endAt = await say(lines.long.samples);
    const until = now() + CLIP_TIMEOUT_MS;
    while (!audibleAt.some((t) => t > endAt) && now() < until) await sleep(20);
    const replyAt = audibleAt.find((t) => t > endAt);
    if (replyAt === undefined) return { stopMs: null };
    await sleep(1000);
    const onset = now() + source.queuedDuration;
    await say(lines.stop.samples);
    // The reply has stopped once 500 ms pass with nothing audible; it stopped at the last frame.
    const giveUp = now() + 8000;
    while (quietSince(onset) < 500 && now() < giveUp) await sleep(20);
    if (quietSince(onset) < 500) return { stopMs: null };
    const last = audibleAt.filter((t) => t >= onset).at(-1) ?? onset;
    await sleep(2000);
    return {
      stopMs: Math.round(last - onset),
      quietAtEpochMs: performance.timeOrigin + last,
    };
  }
}

// --- the run -------------------------------------------------------------------------------

/** The gateway's own first-text-to-first-audio times for one call, from its log. */
function textToAudio(callId: string): number[] {
  if (remote !== undefined) return [];
  const times: number[] = [];
  for (const entry of readGatewayLog(gatewayLog) as Record<string, unknown>[]) {
    if (entry.call_id !== callId || entry.event !== 'tts_first_audio') continue;
    if (typeof entry.after_text_ms === 'number') times.push(entry.after_text_ms);
  }
  return times;
}

/**
 * The gateway's barge-in decision (epoch ms) for the barge-in test: the last `barge_in` in the
 * call before the reply went quiet (earlier clips can barge in too).
 */
function bargeDecidedAt(callId: string, quietAt: number): number | undefined {
  if (remote !== undefined) return undefined;
  const times = (readGatewayLog(gatewayLog) as Record<string, unknown>[]).flatMap((e) =>
    e.call_id === callId &&
    e.event === 'barge_in' &&
    typeof e.time === 'number' &&
    e.time <= quietAt
      ? [e.time]
      : [],
  );
  return times.at(-1);
}

async function main(): Promise<number> {
  const corpus = loadCorpus(corpusPath);
  const utterances = quick ? corpus.filter((u) => u.quick === true) : corpus;
  const recordingsDir = baseEnv.CALL_PROOF_AUDIO_DIR;
  const recordings =
    recordingsDir !== undefined && existsSync(recordingsDir)
      ? readRecordings(recordingsDir)
      : undefined;
  const synthVoices =
    voices.length > 0 ? voices : quick ? DEFAULT_VOICES.slice(0, 1) : DEFAULT_VOICES;
  const recorded = [...(recordings?.values() ?? [])].reduce((n, m) => n + m.size, 0);

  // The cost, before anything is spent.
  const cacheDir = join(workDir, 'cache');
  const perVoice = utterances.reduce((n, u) => n + estimateSeconds(u), 0);
  const uncached = utterances.flatMap((u) =>
    synthVoices.filter((v) => !existsSync(join(cacheDir, v, `${u.id}.wav`))).map(() => u),
  );
  const clipCount = utterances.length * synthVoices.length;
  const sttSeconds =
    conditions.length *
    (perVoice * synthVoices.length + (clipCount * (AFTER_SPEECH_MS + 3000)) / 1000);
  const ttsSeconds =
    uncached.reduce((n, u) => n + u.text.length, 0) / TTS_CHARS_PER_SECOND +
    (conditions.length *
      synthVoices.length *
      utterances.reduce((n, u) => n + 10 + u.text.length, 0)) /
      TTS_CHARS_PER_SECOND;
  console.error(
    `call proof (${quick ? 'quick' : 'full'}): ${utterances.length} lines x ${synthVoices.length} voices` +
      `${recorded > 0 ? ` (${recorded} recordings)` : ''} x ${conditions.length} conditions` +
      `\n  estimated Deepgram use: ~${Math.round(sttSeconds / 60)} min STT, ~${Math.round(ttsSeconds / 60)} min TTS` +
      ` (${uncached.length} lines to voice; the rest cached)` +
      `\n  gateway: ${remote ?? 'local test line (repeat agent)'}`,
  );
  if (flag('estimate')) return 0;

  const clips = await loadClips({
    utterances,
    ...(recordings !== undefined && { recordings }),
    voices: synthVoices,
    cacheDir,
    synthesize: (text, voice) => voiceLine(deepgram!, text, voice),
    onSynthesize: (id, voice) => console.error(`  voicing ${id} (${voice})`),
  });
  const bargeLines = {
    long: clips.find((c) => c.utterance.id === 'u28-long-pause'),
    stop: clips.find((c) => c.utterance.id === 'u23-stop'),
  };
  const longForBarge =
    bargeLines.long ??
    (
      await loadClips({
        utterances: corpus.filter((u) => u.id === 'u28-long-pause'),
        voices: synthVoices.slice(0, 1),
        cacheDir,
        synthesize: (text, voice) => voiceLine(deepgram!, text, voice),
      })
    )[0];

  const child = remote === undefined ? startGateway(gatewayPath, childEnv, gatewayLog) : undefined;
  const stop = () => child?.kill('SIGTERM');
  process.once('SIGINT', () => {
    stop();
    process.exit(130);
  });
  try {
    await waitReady(base);
    const report: ProofReport = { mode: quick ? 'quick' : 'full', conditions: [] };
    const all: UtteranceResult[] = [];
    for (const condition of conditions) {
      const barge =
        condition === 'clean' && longForBarge !== undefined && bargeLines.stop !== undefined
          ? { long: longForBarge, stop: bargeLines.stop }
          : undefined;
      const run = await runCondition(condition, clips, barge);
      process.stderr.write('\n');
      await sleep(1000); // the gateway's last log lines
      report.conditions.push(scoreCondition(condition, run.results, textToAudio(run.callId)));
      all.push(...run.results);
      if (run.bargeIn !== undefined) {
        const { quietAtEpochMs, ...bargeIn } = run.bargeIn;
        const decided =
          quietAtEpochMs === undefined ? undefined : bargeDecidedAt(run.callId, quietAtEpochMs);
        report.bargeIn =
          decided !== undefined && quietAtEpochMs !== undefined
            ? { ...bargeIn, detectedToStopMs: Math.max(0, Math.round(quietAtEpochMs - decided)) }
            : bargeIn;
      }
    }

    mkdirSync(workDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(
      join(workDir, `report-${stamp}.json`),
      JSON.stringify({ report, utterances: all }, null, 2),
    );
    const baseline = existsSync(baselinePath)
      ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as ProofReport)
      : undefined;
    const reasons = judge(report, thresholds(), baseline);
    console.log(JSON.stringify(report));
    console.error(`\n${formatTable(report)}\n`);
    for (const c of report.conditions) {
      if (c.keyTermsMissed.length > 0)
        console.error(`${c.condition} missed: ${c.keyTermsMissed.join('; ')}`);
    }
    if (baseline === undefined || flag('update-baseline')) {
      writeFileSync(baselinePath, JSON.stringify(report, null, 2));
      console.error(`baseline written: ${baselinePath}`);
    }
    if (reasons.length > 0) {
      console.error(`FAIL\n  ${reasons.join('\n  ')}`);
      return 1;
    }
    console.error('PASS');
    return 0;
  } finally {
    stop();
    await dispose();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
