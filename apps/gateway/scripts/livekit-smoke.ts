/**
 * End-to-end audio-path check against a real LiveKit project (Milestone 1 exit evidence).
 *
 *   pnpm --filter @twring/gateway run livekit:smoke
 *
 * Reads LIVEKIT_* from apps/gateway/.env. Starts the gateway in-process, creates a call over HTTP,
 * joins as a Node "phone" that publishes a steady 450 Hz tone as its microphone, and verifies:
 *   1. the gateway reports ready through its participant attribute;
 *   2. gateway ingress hears the caller (audio_stats: frames arriving, tone-level peak);
 *   3. the caller hears the gateway: the ready chime, then its own tone echoed back;
 *   4. hang-up is idempotent, deletes the room, and disconnects the caller.
 * Prints timings as JSON. Exits non-zero on any failed check. Uses real LiveKit minutes (~15 s).
 */
import { liveKitConfig, loadGatewayEnv } from '@twring/config/gateway';
import {
  GATEWAY_IDENTITY,
  GATEWAY_STATE_ATTRIBUTE,
  STATUS_TOPIC,
  callSummarySchema,
  createCallResponseSchema,
  parseStatusMessage,
  type AudioStatsMessage,
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
import { pino } from 'pino';

import { SAMPLE_RATE, SAMPLES_PER_FRAME, peakDbfs, renderTone } from '../src/audio/pcm';
import { buildApp } from '../src/app';
import { systemScheduler } from '../src/calls/scheduler';
import { createLiveKitCalls } from '../src/livekit';

const TIMEOUT_MS = 15_000;
// 450 Hz fits exactly 9 cycles in a 20 ms frame, so one frame loops without a click.
const TONE_HZ = 450;
// 200 ms of steady tone: longer than any chime note, so only the real echo qualifies.
const ECHO_CONFIRM_FRAMES = 10;

const env = loadGatewayEnv({ ...process.env, GATEWAY_AUDIO_TEST_MODE: 'echo', LOG_LEVEL: 'warn' });
const livekit = liveKitConfig(env);
if (livekit === undefined) {
  console.error('Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in apps/gateway/.env');
  process.exit(2);
}

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const timings: Record<string, number> = {};
const checks: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, ...(detail !== undefined && { detail }) });
}

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), TIMEOUT_MS),
    ),
  ]);
}

/** Zero crossings per 20 ms frame ≈ 2 × frequency × 0.02 s. */
function estimateHz(samples: Int16Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i - 1]! < 0 !== samples[i]! < 0) crossings += 1;
  }
  return (crossings / 2) * (SAMPLE_RATE / samples.length);
}

const calls = createLiveKitCalls(
  { kind: 'own', config: livekit, selfhost: false },
  {
    env,
    scheduler: systemScheduler,
    logger: pino({ level: 'warn' }),
  },
);
const app = buildApp({
  env,
  calls: { registry: calls.registry, createRatePerMinute: 100 },
});
const caller = new Room();
const micSource = new AudioSource(SAMPLE_RATE, 1);
let toneRunning = true;

async function publishTone(): Promise<void> {
  const [frame] = renderTone([{ frequencyHz: TONE_HZ, durationMs: 1000 }], 0.3).slice(5, 6);
  while (toneRunning) {
    await micSource.captureFrame(new AudioFrame(frame!, SAMPLE_RATE, 1, SAMPLES_PER_FRAME));
  }
}

async function main(): Promise<void> {
  await app.listen({ host: '127.0.0.1', port: 0 });

  const res = await app.inject({ method: 'POST', url: '/v1/calls', payload: {} });
  timings.create_call_ms = ms();
  check('create call returns 201', res.statusCode === 201, `status ${res.statusCode}`);
  const created = createCallResponseSchema.parse(res.json());

  const gatewayReady = new Promise<void>((resolve) => {
    const isReady = (attrs: Record<string, string>) => attrs[GATEWAY_STATE_ATTRIBUTE] === 'ready';
    caller.on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
      if (participant.identity === GATEWAY_IDENTITY && isReady(participant.attributes)) resolve();
    });
    caller.on(RoomEvent.ParticipantConnected, (participant) => {
      if (isReady(participant.attributes)) resolve();
    });
  });

  const heard = new Promise<AudioStatsMessage>((resolve) => {
    caller.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== STATUS_TOPIC || participant?.identity !== GATEWAY_IDENTITY) return;
      const message = parseStatusMessage(new TextDecoder().decode(payload));
      if (
        message?.type === 'audio_stats' &&
        message.frames_received > 0 &&
        message.peak_dbfs > -30
      ) {
        resolve(message);
      }
    });
  });

  const echo = new Promise<{ chimeAt: number; echoAt: number }>((resolve) => {
    caller.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant) => {
      if (participant.identity !== GATEWAY_IDENTITY || track.kind !== TrackKind.KIND_AUDIO) return;
      void (async () => {
        let chimeAt = 0;
        // A single frame at a chime note's edge can read as any frequency, so the echo counts
        // only once the tone holds for longer than any chime note (120–160 ms).
        let toneRun = 0;
        for await (const frame of new AudioStream(track, {
          sampleRate: SAMPLE_RATE,
          numChannels: 1,
        })) {
          const hz = peakDbfs(frame.data) < -30 ? 0 : estimateHz(frame.data);
          if (chimeAt === 0 && hz > 600) chimeAt = ms();
          toneRun = chimeAt !== 0 && Math.abs(hz - TONE_HZ) < 40 ? toneRun + 1 : 0;
          if (toneRun >= ECHO_CONFIRM_FRAMES) {
            resolve({ chimeAt, echoAt: ms() - (ECHO_CONFIRM_FRAMES - 1) * 20 });
            break;
          }
        }
      })();
    });
  });

  const disconnected = new Promise<void>((resolve) =>
    caller.on(RoomEvent.Disconnected, () => resolve()),
  );

  timings.caller_connect_started_ms = ms();
  await within(
    caller.connect(created.livekit.url, created.livekit.token, {
      autoSubscribe: true,
      dynacast: false,
    }),
    'caller connect',
  );
  timings.caller_connected_ms = ms();

  // An already-present gateway never fires ParticipantConnected; check its attributes directly.
  const gateway = caller.remoteParticipants.get(GATEWAY_IDENTITY);
  const readyNow = gateway?.attributes[GATEWAY_STATE_ATTRIBUTE] === 'ready';

  const mic = LocalAudioTrack.createAudioTrack('microphone', micSource);
  await caller.localParticipant!.publishTrack(
    mic,
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );
  void publishTone();

  if (!readyNow) await within(gatewayReady, 'gateway ready attribute');
  timings.gateway_ready_seen_ms = ms();
  check('gateway announces ready', true);

  const stats = await within(heard, 'audio_stats showing the caller tone');
  timings.gateway_heard_caller_ms = ms();
  check(
    'gateway ingress hears the caller',
    true,
    `${stats.frames_received} frames/s, peak ${stats.peak_dbfs} dBFS`,
  );

  const { chimeAt, echoAt } = await within(echo, 'chime then echoed tone');
  timings.caller_heard_chime_ms = chimeAt;
  timings.caller_heard_echo_ms = echoAt;
  check('caller hears the ready chime and its own echo', true);

  toneRunning = false;
  const endStarted = ms();
  const [end1, end2] = await Promise.all([
    app.inject({ method: 'POST', url: `/v1/calls/${created.call_id}/end` }),
    app.inject({ method: 'POST', url: `/v1/calls/${created.call_id}/end` }),
  ]);
  check('hang-up is idempotent', end1.statusCode === 200 && end2.statusCode === 200);
  check('call ends as ended', callSummarySchema.parse(end1.json()).status === 'ended');
  await within(disconnected, 'caller disconnected after hang-up');
  timings.hangup_to_caller_disconnected_ms = ms() - endStarted;
  check('room deleted: caller disconnected', true);
}

try {
  await main();
} catch (error) {
  check('smoke run', false, error instanceof Error ? error.message : 'unknown error');
} finally {
  toneRunning = false;
  await caller.disconnect().catch(() => undefined);
  await calls.registry.shutdown();
  await app.close();
  await dispose();
}
const ok = checks.length > 0 && checks.every((c) => c.ok);
console.log(JSON.stringify({ ok, checks, timings }, null, 2));
process.exit(ok ? 0 : 1);
