/**
 * Shared pieces of the simulated-phone harness (load-test.ts, call-proof.ts): the gateway child on
 * the test line, its JSON log, and one phone that joins a call through LiveKit and publishes a
 * microphone.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GATEWAY_IDENTITY,
  GATEWAY_STATE_ATTRIBUTE,
  createCallResponseSchema,
  type CreateCallResponse,
} from '@twring/contracts';
import {
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';

import { SAMPLE_RATE } from '../../src/audio/pcm';

import type { GatewayLogEvent } from '../load-test-report';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const now = () => performance.now();

/** The value after `--name` on the command line. */
export function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** systemd-style KEY=VALUE lines (the servers' /etc/cord/gateway.env); quotes are stripped. */
export function readEnvFile(path: string): Record<string, string> {
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

/** True for settings that point at production, which these harnesses never use. */
export function isProduction(env: Record<string, string | undefined>): boolean {
  return env.CORD_ENV === 'production' || (env.CORD_PUBLIC_URL ?? '').includes('api.twring.com');
}

/**
 * The gateway child's settings on the test line: development auth, its own empty data folder,
 * no limits, the given built-in agent (`agent` = scripted fake, `repeat` = says back what it heard).
 */
export function testLineEnv(
  base: Record<string, string | undefined>,
  port: number,
  agent: 'agent' | 'repeat',
): Record<string, string | undefined> {
  return {
    ...base,
    CORD_ENV: 'development',
    AUTH_MODE: 'dev',
    PORT: String(port),
    CORD_PUBLIC_URL: `http://127.0.0.1:${port}`,
    CORD_DATA_DIR: mkdtempSync(join(tmpdir(), 'cord-load-')),
    GATEWAY_AUDIO_TEST_MODE: agent,
    PRESENCE_CUES: 'off',
    CALL_MAX_CONCURRENT: '200',
    CALL_CREATE_RATE_PER_MINUTE: '1000',
    DAILY_CALLS_PER_USER: '0',
    DAILY_CALL_SECONDS_PER_USER: '0',
    // The gateway's own timing events are read from its log.
    LOG_LEVEL: 'info',
    // The invite-only gate would refuse the test user.
    BETA_MEMBERS_FILE: '',
  };
}

/** Starts the built gateway with `env`, its JSON log written to `logPath`. */
export function startGateway(
  gatewayPath: string,
  env: Record<string, string | undefined>,
  logPath: string,
): ChildProcess {
  return spawn(process.execPath, [gatewayPath], {
    env,
    stdio: ['ignore', openSync(logPath, 'w'), 'inherit'],
  });
}

export function readGatewayLog(logPath: string): GatewayLogEvent[] {
  const events: GatewayLogEvent[] = [];
  for (const line of readFileSync(logPath, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      events.push(JSON.parse(line) as GatewayLogEvent);
    } catch {
      // A partial last line: read next time.
    }
  }
  return events;
}

export async function waitReady(base: string): Promise<void> {
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

export interface Phone {
  call: CreateCallResponse;
  room: Room;
  source: AudioSource;
  /** Ends the call on the gateway and leaves the room. */
  hangUp: () => Promise<void>;
}

/**
 * Creates a call as `headers` and joins it with a published microphone fed from the returned
 * source. Listeners for the gateway's audio and data are attached by `beforeConnect`, so nothing
 * sent at join is missed. Resolves once the gateway reports ready, or fails with a reason.
 */
export async function joinCall(
  base: string,
  headers: Record<string, string>,
  beforeConnect: (room: Room) => void,
  readyTimeoutMs = 20_000,
): Promise<{ ok: true; phone: Phone } | { ok: false; reason: string; callId?: string }> {
  const created = await fetch(`${base}/v1/calls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });
  if (created.status !== 201) return { ok: false, reason: `create_${created.status}` };
  const call = createCallResponseSchema.parse(await created.json());
  const room = new Room();
  const source = new AudioSource(SAMPLE_RATE, 1, 200);
  const hangUp = async () => {
    await fetch(`${base}/v1/calls/${call.call_id}/end`, { method: 'POST', headers }).catch(
      () => undefined,
    );
    await room.disconnect().catch(() => undefined);
  };
  beforeConnect(room);
  const ready = new Promise<void>((resolve) => {
    const isReady = (attrs: Record<string, string>) => attrs[GATEWAY_STATE_ATTRIBUTE] === 'ready';
    room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
      if (p.identity === GATEWAY_IDENTITY && isReady(p.attributes)) resolve();
    });
    room.on(RoomEvent.ParticipantConnected, (p) => {
      if (isReady(p.attributes)) resolve();
    });
  });
  try {
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
        sleep(readyTimeoutMs).then(() => true),
      ]);
      if (timedOut) {
        await hangUp();
        return { ok: false, reason: 'not_ready', callId: call.call_id };
      }
    }
  } catch (error) {
    await hangUp();
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'error',
      callId: call.call_id,
    };
  }
  return { ok: true, phone: { call, room, source, hangUp } };
}
