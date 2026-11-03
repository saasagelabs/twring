/**
 * Capacity check: how many calls at once one server
 * carries.
 *
 *   pnpm --filter @twring/gateway run load:test -- --calls 4,8,12,16,20 --turns 3 [--settings F|-]
 *
 * Starts the built gateway (dist/main.js) as a child on the test line (built-in fake agent,
 * CORD_ENV=development, AUTH_MODE=dev, its own empty data folder), then joins N simulated phones
 * from this process. Each phone speaks pre-voiced lines through LiveKit and times the reply from
 * the end of its speech to the first audible reply frame, and the longest stall between reply
 * frames. The child's CPU is sampled every second from /proc (Linux). Each step prints one JSON
 * line (see load-test-report.ts) and the run stops at the first step that fails a budget.
 *
 * Real LiveKit minutes and Deepgram usage: run on staging, never against production. It refuses
 * an env file whose CORD_ENV is production or whose public URL is api.twring.com.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deepgramConfig, loadGatewayEnv } from '@twring/config/gateway';
import {
  GATEWAY_IDENTITY,
  GATEWAY_STATE_ATTRIBUTE,
  createCallResponseSchema,
} from '@twring/contracts';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  dispose,
  type RemoteTrack,
} from '@livekit/rtc-node';

import { FRAME_MS, SAMPLE_RATE, SAMPLES_PER_FRAME, peakDbfs } from '../src/audio/pcm';

import { voiceLine } from './lib/voice';
import {
  serverReplyTimes,
  summarize,
  type CallOutcome,
  type CpuSample,
  type GatewayLogEvent,
  type TurnSample,
} from './load-test-report';

const LINES = [
  'Hello, can you hear me?',
  'What is the capital of France?',
  'Tell me a short fact about the moon.',
];
const AUDIBLE_DBFS = -45;
const REPLY_TIMEOUT_MS = 15_000;
const REPLY_END_SILENCE_MS = 1500;
const READY_TIMEOUT_MS = 20_000;
const CALL_STAGGER_MS = 250;

// --- arguments and environment -------------------------------------------------------------

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const steps = (arg('calls') ?? '1')
  .split(',')
  .map((n) => Number.parseInt(n, 10))
  .filter((n) => n > 0);
const turnsPerCall = Math.max(1, Number.parseInt(arg('turns') ?? '3', 10));
const port = Number.parseInt(arg('port') ?? '8099', 10);
const gatewayPath = arg('gateway') ?? join(import.meta.dirname, '..', 'dist', 'main.js');

/** systemd-style KEY=VALUE lines (the servers' /etc/cord/gateway.env); quotes are stripped. */
function readEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  // `-` reads standard input, so a root-only settings file can be piped in without a copy.
  const text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    env[match[1]!] = value;
  }
  return env;
}

const envFile = arg('settings');
const baseEnv: Record<string, string | undefined> = {
  ...process.env,
  ...(envFile !== undefined && readEnvFile(envFile)),
};
if (
  baseEnv.CORD_ENV === 'production' ||
  (baseEnv.CORD_PUBLIC_URL ?? '').includes('api.twring.com')
) {
  console.error('Refusing to load-test with production settings. Use staging.');
  process.exit(2);
}

const childEnv: Record<string, string | undefined> = {
  ...baseEnv,
  CORD_ENV: 'development',
  AUTH_MODE: 'dev',
  PORT: String(port),
  CORD_PUBLIC_URL: `http://127.0.0.1:${port}`,
  CORD_DATA_DIR: mkdtempSync(join(tmpdir(), 'cord-load-')),
  GATEWAY_AUDIO_TEST_MODE: 'agent',
  PRESENCE_CUES: 'off',
  CALL_MAX_CONCURRENT: '200',
  CALL_CREATE_RATE_PER_MINUTE: '1000',
  DAILY_CALLS_PER_USER: '0',
  DAILY_CALL_SECONDS_PER_USER: '0',
  // The gateway's own timing events decide each step (serverReplyTimes).
  LOG_LEVEL: 'info',
  // The invite-only gate would refuse the test user.
  BETA_MEMBERS_FILE: '',
};
const deepgram = deepgramConfig(loadGatewayEnv(childEnv));
if (deepgram === undefined) {
  console.error('DEEPGRAM_API_KEY is needed to voice the callers.');
  process.exit(2);
}

const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();

// --- the gateway child and its CPU ---------------------------------------------------------

const gatewayLog = arg('gateway-log') ?? join(childEnv.CORD_DATA_DIR!, 'gateway.log');

function startGateway(): ChildProcess {
  return spawn(process.execPath, [gatewayPath], {
    env: childEnv,
    stdio: ['ignore', openSync(gatewayLog, 'w'), 'inherit'],
  });
}

function readGatewayLog(): GatewayLogEvent[] {
  const events: GatewayLogEvent[] = [];
  for (const line of readFileSync(gatewayLog, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      events.push(JSON.parse(line) as GatewayLogEvent);
    } catch {
      // A partial last line: read next time.
    }
  }
  return events;
}

async function waitReady(): Promise<void> {
  const until = now() + 30_000;
  while (now() < until) {
    const ok = await fetch(`${base}/health/ready`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('gateway never became ready');
}

/** CPU ticks (user + system) of a process, from /proc; undefined off Linux. */
function cpuTicks(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return undefined;
  }
}

function sampleCpu(pid: number, into: CpuSample[]): () => void {
  let last = { ticks: cpuTicks(pid), at: now() };
  const timer = setInterval(() => {
    const ticks = cpuTicks(pid);
    const at = now();
    if (ticks !== undefined && last.ticks !== undefined) {
      const seconds = (at - last.at) / 1000;
      into.push({ at, percentOfOneCore: (100 * (ticks - last.ticks)) / 100 / seconds });
    }
    last = { ticks, at };
  }, 1000);
  return () => clearInterval(timer);
}

// --- one simulated phone -------------------------------------------------------------------

const SILENCE = new Int16Array(SAMPLES_PER_FRAME);

async function runPhone(
  callIndex: number,
  user: string,
  voices: Int16Array[],
  turns: TurnSample[],
  callIds: Set<string>,
): Promise<CallOutcome> {
  // One call per user: each phone is its own development user (x-cord-dev-user, auth.ts).
  const as = { 'x-cord-dev-user': user };
  const created = await fetch(`${base}/v1/calls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...as },
    body: '{}',
  });
  if (created.status !== 201) return { callIndex, ok: false, reason: `create_${created.status}` };
  const call = createCallResponseSchema.parse(await created.json());
  callIds.add(call.call_id);
  const room = new Room();
  const source = new AudioSource(SAMPLE_RATE, 1, 200);
  let speaking: Int16Array | undefined;
  let speechEnd: number | undefined;
  let onReply: ((replyMs: number) => void) | undefined;
  let onReplyEnd: ((maxGapMs: number) => void) | undefined;
  let running = true;

  // The microphone: speech when there is a line to say, silence otherwise, paced by the source.
  const mic = (async () => {
    while (running) {
      const line = speaking;
      if (line === undefined) {
        await source.captureFrame(new AudioFrame(SILENCE, SAMPLE_RATE, 1, SAMPLES_PER_FRAME));
        continue;
      }
      for (let offset = 0; offset < line.length && running; offset += SAMPLES_PER_FRAME) {
        const frame = new Int16Array(SAMPLES_PER_FRAME);
        frame.set(line.subarray(offset, offset + SAMPLES_PER_FRAME));
        await source.captureFrame(new AudioFrame(frame, SAMPLE_RATE, 1, SAMPLES_PER_FRAME));
      }
      speechEnd = now() + source.queuedDuration;
      speaking = undefined;
    }
  })();

  // The speaker: the first audible frame after our speech is the reply; frames arriving late
  // (a stall in the server or network) are the gaps; the reply ends after a long silence.
  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
    if (participant.identity !== GATEWAY_IDENTITY || track.kind !== TrackKind.KIND_AUDIO) return;
    void (async () => {
      let lastFrameAt = 0;
      let inReply = false;
      let maxGap = 0;
      let quietSince = 0;
      for await (const frame of new AudioStream(track, {
        sampleRate: SAMPLE_RATE,
        numChannels: 1,
      })) {
        if (!running) break;
        const at = now();
        const audible = peakDbfs(frame.data) > AUDIBLE_DBFS;
        if (!inReply && audible && speechEnd !== undefined && at > speechEnd) {
          inReply = true;
          maxGap = 0;
          quietSince = 0;
          onReply?.(at - speechEnd);
        } else if (inReply) {
          maxGap = Math.max(maxGap, at - lastFrameAt - FRAME_MS);
          if (audible) quietSince = 0;
          else if (quietSince === 0) quietSince = at;
          else if (at - quietSince > REPLY_END_SILENCE_MS) {
            inReply = false;
            speechEnd = undefined;
            onReplyEnd?.(Math.max(0, Math.round(maxGap)));
          }
        }
        lastFrameAt = at;
      }
    })();
  });

  try {
    const ready = new Promise<void>((resolve) => {
      const isReady = (attrs: Record<string, string>) => attrs[GATEWAY_STATE_ATTRIBUTE] === 'ready';
      room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
        if (p.identity === GATEWAY_IDENTITY && isReady(p.attributes)) resolve();
      });
      room.on(RoomEvent.ParticipantConnected, (p) => {
        if (isReady(p.attributes)) resolve();
      });
    });
    await room.connect(call.livekit.url, call.livekit.token, {
      autoSubscribe: true,
      dynacast: false,
    });
    const track = LocalAudioTrack.createAudioTrack('microphone', source);
    await room.localParticipant!.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );
    const already =
      room.remoteParticipants.get(GATEWAY_IDENTITY)?.attributes[GATEWAY_STATE_ATTRIBUTE] ===
      'ready';
    if (!already) {
      const timedOut = await Promise.race([
        ready.then(() => false),
        sleep(READY_TIMEOUT_MS).then(() => true),
      ]);
      if (timedOut) return { callIndex, ok: false, reason: 'not_ready' };
    }
    await sleep(2000); // let the ready chime finish

    for (let turn = 0; turn < turnsPerCall; turn += 1) {
      const replyMs = new Promise<number>((resolve) => (onReply = resolve));
      const gapMs = new Promise<number>((resolve) => (onReplyEnd = resolve));
      speaking = voices[turn % voices.length];
      const reply = await Promise.race([replyMs, sleep(REPLY_TIMEOUT_MS + 10_000).then(() => -1)]);
      if (reply < 0) return { callIndex, ok: false, reason: `no_reply_turn_${turn + 1}` };
      const gap = await Promise.race([gapMs, sleep(30_000).then(() => -1)]);
      if (gap < 0) return { callIndex, ok: false, reason: `reply_never_ended_turn_${turn + 1}` };
      turns.push({ callIndex, turnIndex: turn, replyMs: Math.round(reply), maxGapMs: gap });
    }
    return { callIndex, ok: true };
  } catch (error) {
    return { callIndex, ok: false, reason: error instanceof Error ? error.message : 'error' };
  } finally {
    running = false;
    await mic.catch(() => undefined);
    await fetch(`${base}/v1/calls/${call.call_id}/end`, { method: 'POST', headers: as }).catch(
      () => undefined,
    );
    await room.disconnect().catch(() => undefined);
  }
}

// --- the run -------------------------------------------------------------------------------

async function main(): Promise<number> {
  const voices = await Promise.all(LINES.map((line) => voiceLine(deepgram!, line)));
  const child = startGateway();
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', () => {
    stop();
    process.exit(130);
  });
  try {
    await waitReady();
    const runStep = async (n: number, label: string, baselineServerP95Ms?: number) => {
      const cpu: CpuSample[] = [];
      const turns: TurnSample[] = [];
      const callIds = new Set<string>();
      const stopCpu = sampleCpu(child.pid!, cpu);
      const phones: Promise<CallOutcome>[] = [];
      for (let i = 0; i < n; i += 1) {
        phones.push(runPhone(i, `load-${label}-${i}`, voices, turns, callIds));
        await sleep(CALL_STAGGER_MS);
      }
      const outcomes = await Promise.all(phones);
      stopCpu();
      await sleep(1000); // let the gateway's last log lines land
      const serverMs = serverReplyTimes(readGatewayLog(), callIds);
      const report = summarize(turns, cpu, outcomes, {
        server: { replyMs: serverMs, baselineP95Ms: baselineServerP95Ms ?? Infinity },
      });
      const failures = outcomes.filter((o) => !o.ok).map((o) => o.reason);
      const byTurn = LINES.map((_line, t) => {
        const ms = turns.filter((x) => x.turnIndex === t).map((x) => x.replyMs);
        return ms.length === 0 ? null : Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
      });
      console.log(JSON.stringify({ step: label, ...report, failures, avgReplyMsByTurn: byTurn }));
      return report;
    };
    // One call alone first: what load adds is measured against it, not against a fixed number.
    const baseline = await runStep(1, 'baseline');
    if (
      baseline.failedCalls > 0 ||
      baseline.turns === 0 ||
      baseline.serverReplyP95 === undefined ||
      !Number.isFinite(baseline.serverReplyP95)
    ) {
      console.log(JSON.stringify({ largestPassing: 0, note: 'the one-call baseline failed' }));
      return 1;
    }
    await sleep(5000);
    let largestPassing = 0;
    for (const n of steps) {
      const report = await runStep(n, String(n), baseline.serverReplyP95);
      if (!report.pass) break;
      largestPassing = n;
      await sleep(5000);
    }
    console.log(JSON.stringify({ largestPassing }));
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
