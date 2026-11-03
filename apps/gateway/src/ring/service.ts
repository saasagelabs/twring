import { randomBytes } from 'node:crypto';

import {
  RING_INVITE_TTL_MS,
  RING_RATE_PER_AGENT_PER_HOUR,
  userRef,
  type Invite,
  type InviteStatus,
  type MessagePush,
  type RingSettings,
} from '@twring/contracts';

import type { Scheduler } from '../calls/scheduler';
import { toSafeError } from '../redact';
import type { CallHistoryRepository } from '../store/repositories';

import type { PushPayload, PushSender, PushTarget } from '@twring/push';
import type { InviteRecord, RingStores } from './store';

/**
 * The agent rings the owner (ADR-024). Owns invites from the ring to their end: the 30 s expiry
 * (a missed ring leaves a voicemail entry in call history), the answer race, declines with a note,
 * cancels, the connector's long-poll, and the pushes that make the phone ring and stop ringing.
 * Invites live in a file collection, so a restart keeps them; `recover` settles what expired
 * while the gateway was down.
 */

export interface RingLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
}

/** Why a ring was refused; each maps to a 404/409 with a message the connector prints. */
export type RingRefusal =
  | 'agent_not_saved'
  | 'owner_unavailable'
  | 'owner_busy'
  | 'no_ring_phone'
  | 'ring_pending'
  | 'ring_rate_limited';

/** One phone a push goes to; `forget` drops its address after the push service called it invalid. */
export interface RingPhone {
  target: PushTarget;
  forget(): Promise<void>;
}
export type RingPhones = (userId: string) => Promise<RingPhone[]>;

export interface RingServiceOptions {
  stores: RingStores;
  /**
   * Where a person's phones are pushed. Default: the ring push registrations (`stores.devices`);
   * a self-hosted server passes its paired phones' relay handles.
   */
  phones?: RingPhones;
  history?: CallHistoryRepository;
  /** Undefined when FCM is not configured: invites still work, the phone sees them via GET. */
  push?: PushSender;
  /**
   * Refuse a ring (`no_ring_phone`) when the owner has no Android phone registered: nothing could
   * ring, so the agent should message instead. On wherever push is configured in production.
   */
  requireRingPhone?: boolean;
  /** Platforms whose phones can be rung (default Android); iOS joins when APNs is configured. */
  ringPlatforms?: readonly ('android' | 'ios')[];
  /** Whether the owner is in a call right now. */
  inCall: (userId: string) => boolean;
  scheduler: Pick<Scheduler, 'setTimeout'>;
  now?: () => Date;
  logger: RingLogger;
  newInviteId?: () => string;
  onSettled?: (invite: InviteRecord) => Promise<void>;
}

export interface RingTarget {
  userId: string;
  connectorId?: string;
  localAgent?: string;
  agentId: string;
  agentName: string;
  reason: string;
  sessionRef?: string;
  messageId?: string;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Told to the agent when a ring reached no phone (fits the 60-character decline note). */
export const UNREACHABLE_NOTE = 'Phone unreachable; send a message instead';

/** `inv_` + 26 base32 characters: 130 random bits. */
export function newInviteId(): string {
  let out = 'inv_';
  for (const byte of randomBytes(26)) out += BASE32[byte & 31];
  return out;
}

/** Minutes since local midnight in `tz`, for quiet hours. */
function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** DND, or inside enabled quiet hours (a window may wrap midnight; start = end is all day). */
export function ownerUnavailable(settings: RingSettings, now: Date): boolean {
  if (settings.dnd) return true;
  const quiet = settings.quiet_hours;
  if (quiet === null || !quiet.enabled) return false;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return true;
  let local: number;
  try {
    local = localMinutes(now, quiet.tz);
  } catch {
    return false;
  }
  return start < end ? local >= start && local < end : local >= start || local < end;
}

export type AnswerClaim =
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'handled' }
  | {
      kind: 'claimed';
      invite: InviteRecord;
      release: (answered: boolean, refusedNote?: string) => Promise<void>;
    };

export class RingService {
  private readonly now: () => Date;
  private readonly timers = new Map<string, () => void>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Invites whose answer is starting a call right now: expiry and cancel wait for it. */
  private readonly answering = new Set<string>();
  /** The connector cancelled while an answer was starting: applied if that answer fails. */
  private readonly cancelledWhileAnswering = new Set<string>();
  private readonly background = new Set<Promise<void>>();

  constructor(private readonly options: RingServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Settles invites that expired while the gateway was down and re-arms the rest. */
  async recover(): Promise<void> {
    const now = this.now().getTime();
    for (const invite of await this.options.stores.invites.all()) {
      if (invite.status !== 'pending') continue;
      const left = Date.parse(invite.expires_at) - now;
      if (left <= 0) await this.expire(invite.id);
      else this.arm(invite.id, left);
    }
  }

  /** Places a ring, or says why not. Owner availability comes first, then limits. */
  async ring(target: RingTarget): Promise<{ invite: InviteRecord } | { refused: RingRefusal }> {
    const { stores } = this.options;
    const now = this.now();
    if (ownerUnavailable(await stores.settings.get(target.userId), now)) {
      return { refused: 'owner_unavailable' };
    }
    if (this.options.inCall(target.userId)) return { refused: 'owner_busy' };
    if (
      this.options.requireRingPhone === true &&
      this.options.push !== undefined &&
      !(await this.phones(target.userId)).some(
        ({ target: phone }) =>
          phone.platform !== undefined &&
          (this.options.ringPlatforms ?? ['android']).includes(phone.platform),
      )
    ) {
      return { refused: 'no_ring_phone' };
    }
    const invite: InviteRecord = {
      id: (this.options.newInviteId ?? newInviteId)(),
      user_id: target.userId,
      ...(target.connectorId !== undefined && { connector_id: target.connectorId }),
      ...(target.localAgent !== undefined && { local_agent: target.localAgent }),
      agent_id: target.agentId,
      agent_name: target.agentName,
      reason: target.reason,
      ...(target.sessionRef !== undefined && { session_ref: target.sessionRef }),
      ...(target.messageId !== undefined && { message_id: target.messageId }),
      status: 'pending',
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + RING_INVITE_TTL_MS).toISOString(),
    };
    const hourAgo = now.getTime() - 60 * 60_000;
    const refused = await stores.invites.create<RingRefusal>(invite, now, (mine) => {
      if (
        mine.some((row) => row.status === 'pending' && Date.parse(row.expires_at) > now.getTime())
      ) {
        return 'ring_pending';
      }
      const recent = mine.filter(
        (row) => row.agent_id === target.agentId && Date.parse(row.created_at) > hourAgo,
      );
      return recent.length >= RING_RATE_PER_AGENT_PER_HOUR ? 'ring_rate_limited' : undefined;
    });
    if (refused !== undefined) return { refused };
    this.arm(invite.id, RING_INVITE_TTL_MS);
    this.options.logger.info(
      { event: 'ring_created', invite_id: invite.id, agent_id: invite.agent_id },
      'agent rang its owner',
    );
    this.track(
      this.ringPhones(invite, {
        type: 'cord.ring',
        user_ref: userRef(invite.user_id),
        invite_id: invite.id,
        agent_id: invite.agent_id,
        agent_name: invite.agent_name,
        reason: invite.reason,
        expires_at: invite.expires_at,
        server_time: now.toISOString(),
      }),
    );
    return { invite };
  }

  async settings(userId: string): Promise<RingSettings> {
    return this.options.stores.settings.get(userId);
  }

  nowDate(): Date {
    return this.now();
  }

  async pushMessage(userId: string, payload: MessagePush): Promise<number> {
    const { devices } = await this.sendPush(userId, payload, {
      priority: 'normal',
      ttlSeconds: 86400,
    });
    return devices;
  }

  /**
   * Pushes a ring. When push is set up but no phone took it (every token dead or failing), the
   * ring settles at once as declined with UNREACHABLE_NOTE, so the agent sends a message instead
   * of waiting 30 s for "missed" (review finding 2). The owner still sees it in Recents.
   */
  private async ringPhones(invite: InviteRecord, payload: PushPayload): Promise<void> {
    const { devices, sent, skipped } = await this.sendPush(invite.user_id, payload);
    // A skipped phone (its push service is not set up here) may still see the ring by polling,
    // and a ring being answered right now is not unreachable.
    if (this.options.push === undefined || devices === 0 || sent > 0 || skipped > 0) return;
    if (this.answering.has(invite.id)) return;
    this.options.logger.warn(
      { event: 'ring_unreachable', invite_id: invite.id, devices },
      'ring reached no phone',
    );
    const settled = await this.finish(invite.id, 'declined', UNREACHABLE_NOTE);
    if (settled !== undefined) await this.recordMissed(settled);
  }

  get(userId: string, id: string): Promise<InviteRecord | undefined> {
    return this.options.stores.invites.get(userId, id);
  }

  async listPending(userId: string): Promise<InviteRecord[]> {
    const now = this.now().getTime();
    return (await this.options.stores.invites.list(userId, 'pending')).filter(
      (row) => Date.parse(row.expires_at) > now,
    );
  }

  toInvite(record: InviteRecord): Invite {
    return {
      invite_id: record.id,
      agent_id: record.agent_id,
      agent_name: record.agent_name,
      reason: record.reason,
      status: record.status,
      expires_at: record.expires_at,
      server_time: this.now().toISOString(),
    };
  }

  /**
   * The invite once it is no longer pending, or after `waitMs` (then still pending). Undefined
   * when it is not this user's. Ends early when `signal` aborts (the connector went away).
   */
  async waitForOutcome(
    userId: string,
    id: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<InviteRecord | undefined> {
    const first = await this.get(userId, id);
    if (first === undefined || first.status !== 'pending' || waitMs <= 0) return first;
    // Gone before the wait began: 'abort' never fires again, so don't hold a waiter for nothing.
    if (signal?.aborted === true) return first;
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const done = () => {
        cancelTimer();
        signal?.removeEventListener('abort', done);
        set.delete(done);
        if (set.size === 0) this.waiters.delete(id);
        resolve();
      };
      const cancelTimer = this.options.scheduler.setTimeout(done, waitMs);
      set.add(done);
      signal?.addEventListener('abort', done, { once: true });
      // Settled between the first read and now: no wake-up will come for it.
      void this.get(userId, id).then((now) => {
        if (now?.status !== 'pending') done();
      });
    });
    return this.get(userId, id);
  }

  /** The agent changed its mind. Resolves the invite as it now stands. */
  async cancel(userId: string, id: string): Promise<InviteRecord | undefined> {
    const invite = await this.get(userId, id);
    if (invite === undefined || invite.status !== 'pending') return invite;
    if (this.answering.has(id)) {
      // An answer is starting the call: if that call is refused, the ring ends cancelled rather
      // than ringing on for an agent that gave up. A successful answer still wins.
      this.cancelledWhileAnswering.add(id);
      return invite;
    }
    return (await this.finish(id, 'cancelled')) ?? this.get(userId, id);
  }

  /**
   * The owner declined, with an optional note the agent sees. `expired` after the ring ended,
   * `handled` when someone else settled it first.
   */
  async decline(
    userId: string,
    id: string,
    note: string | undefined,
  ): Promise<{ invite: InviteRecord } | { error: 'not_found' | 'expired' | 'handled' }> {
    const invite = await this.get(userId, id);
    if (invite === undefined) return { error: 'not_found' };
    if (invite.status === 'missed') return { error: 'expired' };
    if (invite.status !== 'pending' || this.answering.has(id)) return { error: 'handled' };
    if (Date.parse(invite.expires_at) <= this.now().getTime()) {
      await this.expire(id);
      return { error: 'expired' };
    }
    const settled = await this.finish(id, 'declined', note);
    return settled === undefined ? { error: 'handled' } : { invite: settled };
  }

  /**
   * Starts answering: exactly one answer wins. The caller starts the call, then `release(true)`
   * marks the invite answered. A refused call (already in a call, daily limit, computer offline)
   * releases with `release(false, note)`: the ring ends declined with that note, so the agent
   * learns why instead of waiting out the ring. `release(false)` alone (the start failed
   * unexpectedly) puts it back to ringing.
   */
  async claimAnswer(userId: string, id: string): Promise<AnswerClaim> {
    const invite = await this.get(userId, id);
    if (invite === undefined) return { kind: 'not_found' };
    if (invite.status === 'missed') return { kind: 'expired' };
    if (invite.status !== 'pending' || this.answering.has(id)) return { kind: 'handled' };
    if (Date.parse(invite.expires_at) <= this.now().getTime()) {
      await this.expire(id);
      return { kind: 'expired' };
    }
    this.answering.add(id);
    let released = false;
    return {
      kind: 'claimed',
      invite,
      release: async (answered, refusedNote) => {
        if (released) return;
        released = true;
        this.answering.delete(id);
        const cancelled = this.cancelledWhileAnswering.delete(id);
        if (answered) {
          await this.finish(id, 'answered');
          return;
        }
        if (cancelled) {
          await this.finish(id, 'cancelled');
          return;
        }
        if (refusedNote !== undefined) {
          await this.finish(id, 'declined', refusedNote);
          return;
        }
        // Failed: it rings on, unless its time ran out meanwhile. The expiry timer skips an
        // invite being answered, so if it already fired, it is armed again for the time left.
        const left = Date.parse(invite.expires_at) - this.now().getTime();
        if (left <= 0) await this.expire(id);
        else if (!this.timers.has(id)) this.arm(id, left);
      },
    };
  }

  /** Deletes the user's invites (their data was deleted) and stops their timers. */
  async deleteAllForUser(userId: string): Promise<number> {
    const mine = await this.options.stores.invites.list(userId);
    // Delete first, then wake: a long-poll that wakes must find the invite gone (404), not
    // still pending.
    const deleted = await this.options.stores.invites.deleteAllForUser(userId);
    for (const invite of mine) {
      this.timers.get(invite.id)?.();
      this.timers.delete(invite.id);
      this.cancelledWhileAnswering.delete(invite.id);
      this.wake(invite.id);
    }
    return deleted;
  }

  /** Test seam: resolves once pushes and history writes in flight have settled. */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** Stops every timer (shutdown). Pending invites are settled by `recover` on the next start. */
  close(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  private arm(id: string, ms: number): void {
    this.timers.get(id)?.();
    this.timers.set(
      id,
      this.options.scheduler.setTimeout(() => {
        this.timers.delete(id);
        // An answer in flight settles it (answered, or expired when it fails).
        if (this.answering.has(id)) return;
        this.track(this.expire(id));
      }, ms),
    );
  }

  /** A ring nobody answered: missed, with a voicemail entry in the owner's call history. */
  private async expire(id: string): Promise<void> {
    const invite = await this.finish(id, 'missed');
    if (invite !== undefined) await this.recordMissed(invite);
  }

  /** A Recents entry for a ring the owner did not take (missed, or no phone reachable). */
  private async recordMissed(invite: InviteRecord): Promise<void> {
    const id = invite.id;
    if (this.options.history === undefined) return;
    try {
      await this.options.history.record(invite.user_id, {
        call_id: invite.id,
        kind: 'missed_invite',
        agent_id: invite.agent_id,
        agent_name: invite.agent_name,
        reason: invite.reason,
        started_at: invite.created_at,
        duration_s: 0,
        outcome: 'missed',
      });
    } catch (error) {
      this.options.logger.warn(
        { event: 'ring_history_failed', invite_id: id, err: toSafeError(error) },
        'could not record the missed ring',
      );
    }
  }

  /** Settles a pending invite, wakes long-polls, and tells the phones to stop ringing. */
  private async finish(
    id: string,
    status: Exclude<InviteStatus, 'pending'>,
    note?: string,
  ): Promise<InviteRecord | undefined> {
    const settled = await this.options.stores.invites.settle(id, status, this.now(), note);
    if (settled === undefined) return undefined;
    this.timers.get(id)?.();
    this.timers.delete(id);
    this.wake(id);
    this.options.logger.info({ event: 'ring_settled', invite_id: id, status }, `ring ${status}`);
    this.pushToUser(settled.user_id, {
      type: 'cord.ring_cancel',
      user_ref: userRef(settled.user_id),
      invite_id: id,
      status,
      agent_name: settled.agent_name,
    });
    if (this.options.onSettled) {
      try {
        await this.options.onSettled(settled);
      } catch (error) {
        this.options.logger.warn({
          event: 'ring_thread_failed',
          invite_id: id,
          err: toSafeError(error),
        });
      }
    }
    return settled;
  }

  private wake(id: string): void {
    for (const waiter of [...(this.waiters.get(id) ?? [])]) waiter();
  }

  private pushToUser(userId: string, payload: PushPayload): void {
    this.track(this.sendPush(userId, payload).then(() => undefined));
  }

  private track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => {
        this.options.logger.warn({ event: 'ring_task_failed', err: toSafeError(error) });
      })
      .finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** The person's phones to push: the configured source, or the ring push registrations. */
  private async phones(userId: string): Promise<RingPhone[]> {
    if (this.options.phones !== undefined) return this.options.phones(userId);
    const { devices } = this.options.stores;
    return (await devices.list(userId)).map((device) => ({
      target: {
        token: device.fcm_token,
        platform: device.platform,
        ...(device.apns_token !== undefined && { apnsToken: device.apns_token }),
      },
      forget: () => devices.deleteToken(device.fcm_token),
    }));
  }

  private async sendPush(
    userId: string,
    payload: PushPayload,
    options?: { priority: 'high' | 'normal'; ttlSeconds: number },
  ): Promise<{ devices: number; sent: number; skipped: number }> {
    const { push, logger } = this.options;
    if (push === undefined) {
      logger.info(
        {
          event: 'push_unconfigured',
          type: payload.type,
          ...(payload.type === 'cord.message'
            ? { message_id: payload.message_id }
            : { invite_id: payload.invite_id }),
        },
        'FCM not configured: no push sent',
      );
      return { devices: 0, sent: 0, skipped: 0 };
    }
    const devices = await this.phones(userId);
    const results = await Promise.all(
      devices.map(async (phone) => {
        const outcome = await push
          .send(phone.target, payload, options)
          .catch(() => 'failed' as const);
        if (outcome === 'invalid') await phone.forget();
        return outcome;
      }),
    );
    logger.info({
      event: 'push_sent',
      ...(payload.type === 'cord.message'
        ? { message_id: payload.message_id }
        : { invite_id: payload.invite_id }),
      type: payload.type,
      devices: devices.length,
      sent: results.filter((r) => r === 'sent').length,
      invalid: results.filter((r) => r === 'invalid').length,
      failed: results.filter((r) => r === 'failed').length,
      skipped: results.filter((r) => r === 'skipped').length,
    });
    return {
      devices: devices.length,
      sent: results.filter((r) => r === 'sent').length,
      skipped: results.filter((r) => r === 'skipped').length,
    };
  }
}
