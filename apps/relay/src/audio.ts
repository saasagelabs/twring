import {
  GATEWAY_IDENTITY,
  RELAY_AUDIO_MAX_SESSION_SECONDS,
  RELAY_AUDIO_TOKEN_TTL_SECONDS,
  relayAudioRoom,
  relayCallerIdentity,
} from '@twring/contracts';
import {
  AccessToken,
  RoomConfiguration,
  RoomServiceClient,
  TrackSource,
  WebhookReceiver,
} from 'livekit-server-sdk';

import type { RelayDb } from './db';
import type { UsageStore } from './usage';

/** Twring's LiveKit project, as the relay uses it. The secret never leaves the relay. */
export interface AudioLiveKit {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** Room administration on Twring's LiveKit (the relay holds admin rights on its project). */
/** Where the store reports what operators should see. */
export interface AudioLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface AudioRooms {
  /** Closes a room and disconnects everyone; resolves if it is already gone. */
  deleteRoom(name: string): Promise<void>;
  /** Which of `names` exist now. */
  listRooms(names: string[]): Promise<string[]>;
}

/** The same room settings the server uses for its own rooms (apps/gateway ROOM_SETTINGS). */
const ROOM_SETTINGS = { emptyTimeoutS: 60, departureTimeoutS: 20, maxParticipants: 2 } as const;
/** A session never reported ended (no webhook, no end report) is closed after the longest call. */
const MAX_SESSION_MS = RELAY_AUDIO_MAX_SESSION_SECONDS * 1000;
const MAX_MINUTES = RELAY_AUDIO_MAX_SESSION_SECONDS / 60;

/** Minutes of a session from `startedAt` to `at`: rounded up, at least 1, at most 2 hours. */
function sessionMinutes(startedAt: number, at: number): number {
  return Math.min(MAX_MINUTES, Math.max(1, Math.ceil((at - startedAt) / 60_000)));
}

/**
 * What a LiveKit webhook says about a room: it finished (`room_finished`) or it is in use
 * (`room_started`, `participant_joined`). Throws when the signature (the relay's LiveKit key)
 * does not hold.
 */
export async function roomEventFromWebhook(
  receiver: WebhookReceiver,
  body: string,
  authorization: string | undefined,
): Promise<{ kind: 'finished' | 'started'; room: string } | undefined> {
  const event = await receiver.receive(body, authorization);
  const room = event.room;
  if (room === undefined || room.name === '') return undefined;
  if (event.event === 'room_finished') return { kind: 'finished', room: room.name };
  if (event.event === 'room_started' || event.event === 'participant_joined') {
    return { kind: 'started', room: room.name };
  }
  return undefined;
}

export function createWebhookReceiver(livekit: AudioLiveKit): WebhookReceiver {
  return new WebhookReceiver(livekit.apiKey, livekit.apiSecret);
}

function roomConfig(room: string): RoomConfiguration {
  return new RoomConfiguration({
    name: room,
    emptyTimeout: ROOM_SETTINGS.emptyTimeoutS,
    departureTimeout: ROOM_SETTINGS.departureTimeoutS,
    maxParticipants: ROOM_SETTINGS.maxParticipants,
  });
}

/**
 * The phone's and the server's tokens for one room, each limited to that room for 2 hours. The
 * phone publishes only a microphone; the server joins as the agent, as on its own LiveKit.
 */
export async function mintAudioTokens(
  livekit: AudioLiveKit,
  room: string,
  callId: string,
): Promise<{ caller: string; server: string }> {
  const caller = new AccessToken(livekit.apiKey, livekit.apiSecret, {
    identity: relayCallerIdentity(callId),
    ttl: RELAY_AUDIO_TOKEN_TTL_SECONDS,
  });
  caller.roomConfig = roomConfig(room);
  caller.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  const server = new AccessToken(livekit.apiKey, livekit.apiSecret, {
    identity: GATEWAY_IDENTITY,
    name: 'Twring',
    ttl: RELAY_AUDIO_TOKEN_TTL_SECONDS,
  });
  server.kind = 'agent';
  server.roomConfig = roomConfig(room);
  server.addGrant({
    room,
    roomJoin: true,
    agent: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
  });
  return { caller: await caller.toJwt(), server: await server.toJwt() };
}

export function createAudioRooms(livekit: AudioLiveKit): AudioRooms {
  const api = new URL(livekit.url);
  api.protocol = api.protocol === 'wss:' ? 'https:' : 'http:';
  const client = new RoomServiceClient(api.origin, livekit.apiKey, livekit.apiSecret);
  return {
    async deleteRoom(name) {
      try {
        await client.deleteRoom(name);
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (status !== 404) throw error;
      }
    },
    async listRooms(names) {
      return (await client.listRooms(names)).map((room) => room.name);
    },
  };
}

interface SessionRow {
  room: string;
  install_id: string;
  started_at: number;
  ended_at: number | null;
  /** When the server reported the end (the room was deleted then); settled later. */
  ending_at: number | null;
  /** LiveKit reported the room started (or a join). */
  room_started: number;
  /** Minutes counted so far (a reopened session adds only the rest). */
  minutes: number | null;
}

/** How long after an end report the sweeper waits for `room_finished`. */
const ENDING_GRACE_MS = 3 * 60_000;
/** A session whose room never started is closed (billed 0) after this. */
const NEVER_STARTED_MS = 10 * 60_000;
/** How long a per-call audio record is kept after the call ended. */
export const AUDIO_RECORD_KEEP_MS = 90 * 86_400_000;

/** How often the relay sweeps audio sessions. */
export const AUDIO_SWEEP_EVERY_MS = 60_000;

export type OpenResult =
  | { ok: true; room: string; startedAt: number }
  | { ok: false; reason: 'exists' | 'concurrent' | 'minutes' };

/** Twring-run call audio sessions, per install. LiveKit's word settles the minutes. */
export class AudioSessionStore {
  constructor(
    private readonly db: RelayDb,
    private readonly usage: UsageStore,
    private readonly limits: {
      maxConcurrent: number;
      minutesPerDay: number;
      /** Relay-wide, across every install. */
      maxConcurrentTotal: number;
      minutesPerDayTotal: number;
    },
    private readonly log?: AudioLog,
  ) {}

  /** Reserves the install's room for a call, within its fair-use limits. */
  open(installId: string, callId: string, now: number): OpenResult {
    this.closeStale(installId, now);
    const room = relayAudioRoom(installId, callId);
    const sqlite = this.db.sqlite;
    if (sqlite.prepare('SELECT 1 FROM audio_sessions WHERE room = ?').get(room) !== undefined) {
      return { ok: false, reason: 'exists' };
    }
    const open = sqlite
      .prepare('SELECT COUNT(*) AS n FROM audio_sessions WHERE install_id = ? AND ended_at IS NULL')
      .get(installId) as { n: number };
    if (open.n >= this.limits.maxConcurrent) return { ok: false, reason: 'concurrent' };
    const today = new Date(now).toISOString().slice(0, 10);
    // Calls still going count at their minutes so far.
    const going = sqlite
      .prepare('SELECT started_at FROM audio_sessions WHERE install_id = ? AND ended_at IS NULL')
      .all(installId) as { started_at: number }[];
    const used =
      (this.usage.forDay(installId, today).audio_minutes ?? 0) +
      going.reduce((sum, row) => sum + sessionMinutes(row.started_at, now), 0);
    if (used >= this.limits.minutesPerDay) return { ok: false, reason: 'minutes' };
    // The whole relay: calls at once and today's minutes across every install.
    const allGoing = sqlite
      .prepare('SELECT started_at FROM audio_sessions WHERE ended_at IS NULL')
      .all() as { started_at: number }[];
    if (allGoing.length >= this.limits.maxConcurrentTotal) {
      return { ok: false, reason: 'concurrent' };
    }
    const usedTotal =
      this.usage.totalForDay('audio_minutes', today) +
      allGoing.reduce((sum, row) => sum + sessionMinutes(row.started_at, now), 0);
    if (usedTotal >= this.limits.minutesPerDayTotal) return { ok: false, reason: 'minutes' };
    sqlite
      .prepare(
        'INSERT INTO audio_sessions (room, install_id, call_id, started_at) VALUES (?, ?, ?, ?)',
      )
      .run(room, installId, callId, now);
    return { ok: true, room, startedAt: now };
  }

  /** Forgets a reservation whose tokens could not be made (nothing was used). */
  discard(room: string): void {
    this.db.sqlite.prepare('DELETE FROM audio_sessions WHERE room = ?').run(room);
  }

  /**
   * The server's end report (by room or call id): the session is `ending` and the caller deletes
   * the room on LiveKit. Minutes are not settled and the line is not freed here; LiveKit's
   * `room_finished` (or the sweeper, once LiveKit says the room is gone) does that. `missing`
   * when the room is not this install's (another install's room is never touched).
   */
  requestEnd(installId: string, room: string, now: number): 'ending' | 'already' | 'missing' {
    const row = this.db.sqlite
      .prepare('SELECT ended_at FROM audio_sessions WHERE room = ? AND install_id = ?')
      .get(room, installId) as { ended_at: number | null } | undefined;
    if (row === undefined) return 'missing';
    if (row.ended_at !== null) return 'already';
    this.db.sqlite
      .prepare('UPDATE audio_sessions SET ending_at = COALESCE(ending_at, ?) WHERE room = ?')
      .run(now, room);
    return 'ending';
  }

  /** LiveKit: the room finished. Settles the minutes from start to now and frees the line. */
  finished(room: string, now: number): boolean {
    const row = this.row(room);
    if (row === undefined || row.ended_at !== null) return false;
    this.close(row, now, sessionMinutes(row.started_at, now));
    return true;
  }

  /**
   * LiveKit: the room started or someone joined. True when the session is ending or ended: the
   * caller deletes the room again, and a settled session reopens (as ending) so its minutes keep
   * counting until the room finishes.
   */
  started(room: string, now: number): boolean {
    const row = this.row(room);
    if (row === undefined) return false;
    this.db.sqlite.prepare('UPDATE audio_sessions SET room_started = 1 WHERE room = ?').run(room);
    if (row.ended_at === null && row.ending_at === null) return false;
    this.db.sqlite
      .prepare(
        'UPDATE audio_sessions SET ended_at = NULL, ending_at = COALESCE(ending_at, ?) WHERE room = ?',
      )
      .run(now, room);
    return true;
  }

  /**
   * The sweeper, for LiveKit webhooks that never came. An ending session with no `room_finished`
   * 3 minutes after the end report settles at the end time once LiveKit says the room is gone (a
   * live room is deleted again). A session whose room never started within 10 minutes closes
   * billed 0 once LiveKit says there is no room.
   */
  async sweep(rooms: AudioRooms, now: number): Promise<void> {
    this.closeStale(undefined, now);
    // Rooms of sessions the two-hour net closed: deleted here, retried each sweep until done.
    const pending = this.db.sqlite
      .prepare('SELECT room, install_id FROM audio_sessions WHERE room_close_pending = 1')
      .all() as { room: string; install_id: string }[];
    for (const { room, install_id } of pending) {
      try {
        await rooms.deleteRoom(room);
        this.db.sqlite
          .prepare('UPDATE audio_sessions SET room_close_pending = 0 WHERE room = ?')
          .run(room);
      } catch {
        this.log?.warn(
          { event: 'audio_room_delete_failed', install_id },
          'could not close a call audio room; retrying on the next sweep',
        );
      }
    }
    const rows = this.db.sqlite
      .prepare(
        `SELECT room, install_id, started_at, ended_at, ending_at, room_started, minutes
         FROM audio_sessions WHERE ended_at IS NULL
           AND ((ending_at IS NOT NULL AND ending_at <= ?) OR (room_started = 0 AND started_at <= ?))`,
      )
      .all(now - ENDING_GRACE_MS, now - NEVER_STARTED_MS) as unknown as SessionRow[];
    if (rows.length === 0) return;
    const alive = new Set(await rooms.listRooms(rows.map((row) => row.room)));
    for (const row of rows) {
      if (alive.has(row.room)) {
        if (row.ending_at !== null) await rooms.deleteRoom(row.room).catch(() => undefined);
        continue;
      }
      const fresh = this.row(row.room);
      if (fresh === undefined || fresh.ended_at !== null) continue;
      if (fresh.room_started === 0) {
        this.close(fresh, now, 0);
        this.webhooksMissing(fresh.install_id);
      } else
        this.close(fresh, fresh.ending_at!, sessionMinutes(fresh.started_at, fresh.ending_at!));
    }
  }

  /** Per-call records are kept 90 days after the call ended (daily minute totals stay). */
  prune(now: number): void {
    this.db.sqlite
      .prepare('DELETE FROM audio_sessions WHERE ended_at IS NOT NULL AND ended_at <= ?')
      .run(now - AUDIO_RECORD_KEEP_MS);
  }

  /** Rooms of this install's calls still open (deleted on LiveKit before the install goes). */
  openRooms(installId: string): string[] {
    return (
      this.db.sqlite
        .prepare('SELECT room FROM audio_sessions WHERE install_id = ? AND ended_at IS NULL')
        .all(installId) as { room: string }[]
    ).map((row) => row.room);
  }

  private row(room: string): SessionRow | undefined {
    return this.db.sqlite
      .prepare(
        'SELECT room, install_id, started_at, ended_at, ending_at, room_started, minutes FROM audio_sessions WHERE room = ?',
      )
      .get(room) as SessionRow | undefined;
  }

  /**
   * Sessions never settled close after the longest call (billed only if their room started), and
   * their rooms are marked for the sweeper to delete; a rejoin is then caught by `started`.
   * One install's (when a call starts), or every install's (the sweeper).
   */
  private closeStale(installId: string | undefined, now: number): void {
    const columns =
      'room, install_id, started_at, ended_at, ending_at, room_started, minutes FROM audio_sessions';
    const stale = (installId === undefined
      ? this.db.sqlite
          .prepare(`SELECT ${columns} WHERE ended_at IS NULL AND started_at <= ?`)
          .all(now - MAX_SESSION_MS)
      : this.db.sqlite
          .prepare(
            `SELECT ${columns} WHERE install_id = ? AND ended_at IS NULL AND started_at <= ?`,
          )
          .all(installId, now - MAX_SESSION_MS)) as unknown as SessionRow[];
    for (const row of stale) {
      this.close(row, row.started_at + MAX_SESSION_MS, row.room_started === 0 ? 0 : MAX_MINUTES);
      this.db.sqlite
        .prepare('UPDATE audio_sessions SET room_close_pending = 1 WHERE room = ?')
        .run(row.room);
      if (row.room_started === 0) this.webhooksMissing(row.install_id);
    }
  }

  /** Settled with no word from LiveKit: its webhooks may be missing or misconfigured. */
  private webhooksMissing(installId: string): void {
    this.log?.warn(
      { event: 'audio_webhooks_missing', install_id: installId },
      'a call audio session settled with no webhook from LiveKit; check its webhook setup',
    );
  }

  /** Settles a session at `minutes` in all; only what was not counted before is added. */
  private close(row: SessionRow, at: number, minutes: number): void {
    const result = this.db.sqlite
      .prepare(
        'UPDATE audio_sessions SET ended_at = ?, minutes = ? WHERE room = ? AND ended_at IS NULL',
      )
      .run(at, Math.max(minutes, row.minutes ?? 0), row.room);
    const added = minutes - (row.minutes ?? 0);
    if (result.changes === 1 && added > 0) {
      this.usage.add(row.install_id, 'audio_minutes', added, row.started_at);
    }
  }
}
