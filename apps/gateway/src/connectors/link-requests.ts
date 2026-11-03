import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

import type { LinkAgent, LinkApproveResponse, LinkPollResponse } from '@twring/contracts';

import { newPairingCode } from './pairing';

/** How long a computer's link code works. */
export const LINK_TTL_MS = 10 * 60_000;
/** Open link requests across the whole server: the memory bound for an unauthenticated route. */
export const MAX_OPEN_LINKS = 1000;
/** Open link requests from one address at once; the oldest is dropped first. */
export const MAX_OPEN_LINKS_PER_IP = 5;
/** Finished requests stay this long so a late poll still hears `expired` or `rejected`. */
const FINISHED_RETENTION_MS = 10 * 60_000;
/** An approval may go to the same poll token again this long (its first delivery was lost). */
export const REDELIVERY_MS = 60_000;

/**
 * The key per-address limits count under: the whole address for IPv4 (IPv4-mapped IPv6 included),
 * the /64 for IPv6, since one host is usually handed a whole /64 to pick addresses from.
 */
export function ipKey(ip: string): string {
  const address = ip.trim().replace(/%.*$/, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  if (!isIPv6(address)) return address;
  let text = address;
  // A dotted tail (`::1.2.3.4`) is the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    const hex = (hi: number, lo: number) => ((hi << 8) | lo).toString(16);
    text = `${text.slice(0, dotted.index)}${hex(a, b)}:${hex(c, d)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  const prefix = groups.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

/**
 * The account a computer joined, as its owner will recognise it: their name, else their email
 * masked as `g***@gmail.com`. Undefined when the sign-in carries neither.
 */
export function ownerDisplayName(profile: { name?: string; email?: string }): string | undefined {
  const clean = (text: string | undefined) => (text ?? '').replace(UNSAFE_TEXT, '').trim();
  const name = [...clean(profile.name)].slice(0, 60).join('');
  if (name !== '') return name;
  const email = clean(profile.email);
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return undefined;
  const masked = `${[...email.slice(0, at)][0] ?? ''}***@${email.slice(at + 1)}`;
  return masked.length <= 80 ? masked : undefined;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function newLinkId(): string {
  let out = '';
  for (const byte of randomBytes(20)) out += ID_ALPHABET[byte & 31];
  return `link_${out}`;
}

/** 256 random bits for the computer to poll with. Only its hash is kept. */
function newPollToken(): string {
  return `clp_${randomBytes(32).toString('base64url')}`;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export type LinkState =
  | { kind: 'pending' }
  /** A phone is creating the connector right now: no second approval, no rejection. */
  | { kind: 'approving'; userId: string }
  | {
      kind: 'approved';
      userId: string;
      connectorId: string;
      token: string;
      ownerName?: string;
      /** Set at the first delivery: the same poll token may collect it again until then. */
      redeliverUntil?: number;
    }
  | { kind: 'rejected' }
  /** The computer gave up (Ctrl+C): the phone hears "expired". */
  | { kind: 'cancelled' };

export interface LinkRequest {
  id: string;
  code: string;
  ip: string;
  computerName: string;
  agents: LinkAgent[];
  expiresAt: number;
  state: LinkState;
  pollTokenHash: Buffer;
}

/** An approval remembered for the phone that made it, so its retry gets the same answer. */
interface Approval {
  userId: string;
  response: LinkApproveResponse;
  until: number;
}

export type LinkCreateResult =
  { ok: true; request: LinkRequest; pollToken: string } | { ok: false; reason: 'full' };

/**
 * Computer-first link requests (ADR-025), in memory like the pairing book: they live 10 minutes,
 * so a restart only means running `cord-connect` again. The computer polls with a secret token;
 * the phone finds the request by its short code, and only a signed-in user can approve it.
 */
export class LinkBook {
  private readonly byId = new Map<string, LinkRequest>();
  private readonly byCode = new Map<string, LinkRequest>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Approved codes, by code: a phone whose answer was lost asks again and gets the same one. */
  private readonly approvals = new Map<string, Approval>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(ip: string, computerName: string, agents: LinkAgent[]): LinkCreateResult {
    this.sweep();
    const fromIp = [...this.byId.values()]
      .filter((r) => r.ip === ip && this.isOpen(r))
      .sort((a, b) => a.expiresAt - b.expiresAt);
    while (fromIp.length >= MAX_OPEN_LINKS_PER_IP) this.forget(fromIp.shift()!);
    if ([...this.byId.values()].filter((r) => this.isOpen(r)).length >= MAX_OPEN_LINKS) {
      return { ok: false, reason: 'full' };
    }
    let code = newPairingCode();
    while (this.byCode.has(code) || this.approvals.has(code)) code = newPairingCode();
    const pollToken = newPollToken();
    const request: LinkRequest = {
      id: newLinkId(),
      code,
      ip,
      computerName,
      agents,
      expiresAt: this.now() + LINK_TTL_MS,
      state: { kind: 'pending' },
      pollTokenHash: hashToken(pollToken),
    };
    this.byId.set(request.id, request);
    this.byCode.set(code, request);
    return { ok: true, request, pollToken };
  }

  /** A pending, unexpired request by its code (`ABCD-EFGH`), for the phone. */
  pendingByCode(code: string): LinkRequest | undefined {
    const request = this.byCode.get(code);
    return request !== undefined && this.isOpen(request) ? request : undefined;
  }

  /** Starts approving: the request can no longer be approved or rejected by anyone else. */
  beginApprove(code: string, userId: string): LinkRequest | undefined {
    const request = this.pendingByCode(code);
    if (request === undefined) return undefined;
    request.state = { kind: 'approving', userId };
    return request;
  }

  /** Creating the connector failed: the code works again. */
  abortApprove(request: LinkRequest): void {
    if (request.state.kind === 'approving') request.state = { kind: 'pending' };
  }

  approved(request: LinkRequest, connectorId: string, token: string, ownerName?: string): void {
    if (request.state.kind !== 'approving') return;
    const userId = request.state.userId;
    request.state = {
      kind: 'approved',
      userId,
      connectorId,
      token,
      ...(ownerName !== undefined && { ownerName }),
    };
    this.byCode.delete(request.code);
    this.approvals.set(request.code, {
      userId,
      response: {
        connector_id: connectorId,
        computer_name: request.computerName,
        agents: request.agents,
      },
      until: this.now() + FINISHED_RETENTION_MS,
    });
    this.notify(request.id);
  }

  /**
   * The answer `userId` already got for approving `code`, if they did: approving is idempotent for
   * the same phone (its first answer may have been lost), never for anyone else.
   */
  approvalFor(code: string, userId: string): LinkApproveResponse | undefined {
    const approval = this.approvals.get(code);
    if (approval === undefined || approval.userId !== userId) return undefined;
    if (approval.until <= this.now()) {
      this.approvals.delete(code);
      return undefined;
    }
    return approval.response;
  }

  /**
   * Whether `code` belonged to a request that expired or that its computer cancelled: the phone
   * says "expired", and it is not a wrong guess.
   */
  isExpiredCode(code: string): boolean {
    const request = this.byCode.get(code);
    if (request === undefined) return false;
    return (
      request.state.kind === 'cancelled' ||
      (request.state.kind === 'pending' && request.expiresAt <= this.now())
    );
  }

  /** The computer withdraws its own request. False for an unknown id or a wrong token. */
  cancel(id: string, pollToken: string): boolean {
    const request = this.byId.get(id);
    if (request === undefined || !timingSafeEqual(hashToken(pollToken), request.pollTokenHash)) {
      return false;
    }
    if (request.state.kind === 'pending') {
      request.state = { kind: 'cancelled' };
      this.notify(request.id);
    }
    return true;
  }

  reject(code: string): boolean {
    const request = this.pendingByCode(code);
    if (request === undefined) return false;
    request.state = { kind: 'rejected' };
    this.byCode.delete(request.code);
    this.notify(request.id);
    return true;
  }

  /**
   * The computer's view. Undefined for an unknown id or a wrong token (the same answer, so the
   * id alone reveals nothing). An approval goes to this token again for `REDELIVERY_MS` after its
   * first delivery (a connection that dropped as it arrived asks again), then it is forgotten.
   */
  poll(id: string, pollToken: string): LinkPollResponse | undefined {
    const request = this.byId.get(id);
    if (request === undefined) return undefined;
    const given = hashToken(pollToken);
    if (!timingSafeEqual(given, request.pollTokenHash)) return undefined;
    switch (request.state.kind) {
      case 'approved': {
        const state = request.state;
        if (state.redeliverUntil === undefined) {
          state.redeliverUntil = this.now() + REDELIVERY_MS;
        } else if (state.redeliverUntil <= this.now()) {
          this.forget(request);
          return undefined;
        }
        return {
          status: 'approved',
          connector_token: state.token,
          connector_id: state.connectorId,
          ...(state.ownerName !== undefined && { owner_name: state.ownerName }),
        };
      }
      case 'rejected':
        return { status: 'rejected' };
      case 'cancelled':
        return { status: 'expired' };
      case 'pending':
      case 'approving':
        return request.expiresAt <= this.now() && request.state.kind === 'pending'
          ? { status: 'expired' }
          : { status: 'pending' };
    }
  }

  /** `poll`, waiting up to `ms` while the answer is still `pending`. */
  async wait(
    id: string,
    pollToken: string,
    ms: number,
    signal: AbortSignal,
  ): Promise<LinkPollResponse | undefined> {
    const first = this.poll(id, pollToken);
    if (first?.status !== 'pending' || ms <= 0 || signal.aborted) return first;
    const request = this.byId.get(id);
    const untilExpiry = request === undefined ? 0 : Math.max(0, request.expiresAt - this.now());
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        this.waiters.get(id)?.delete(done);
        if (this.waiters.get(id)?.size === 0) this.waiters.delete(id);
        resolve();
      };
      // Wake at expiry too, so the computer hears `expired` without another round trip.
      const timer = setTimeout(done, Math.min(ms, untilExpiry + 50));
      signal.addEventListener('abort', done, { once: true });
      let set = this.waiters.get(id);
      if (set === undefined) {
        set = new Set();
        this.waiters.set(id, set);
      }
      set.add(done);
    });
    if (signal.aborted) return { status: 'pending' };
    return this.poll(id, pollToken);
  }

  /** Waiters currently parked (tests check nothing leaks). */
  waiterCount(): number {
    let n = 0;
    for (const set of this.waiters.values()) n += set.size;
    return n;
  }

  /** Drops approvals a user's computer has not collected yet (their data was deleted). */
  forgetUser(userId: string): void {
    for (const [code, approval] of [...this.approvals]) {
      if (approval.userId === userId) this.approvals.delete(code);
    }
    for (const request of [...this.byId.values()]) {
      const state = request.state;
      if ((state.kind === 'approved' || state.kind === 'approving') && state.userId === userId) {
        this.forget(request);
      }
    }
  }

  private isOpen(request: LinkRequest): boolean {
    return request.state.kind === 'pending' && request.expiresAt > this.now();
  }

  private notify(id: string): void {
    for (const wake of [...(this.waiters.get(id) ?? [])]) wake();
  }

  private forget(request: LinkRequest): void {
    this.byId.delete(request.id);
    if (this.byCode.get(request.code) === request) this.byCode.delete(request.code);
    this.notify(request.id);
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, approval] of [...this.approvals]) {
      if (approval.until <= now) this.approvals.delete(code);
    }
    for (const request of [...this.byId.values()]) {
      const state = request.state;
      if (state.kind === 'approving') continue;
      // An expired code stays findable (as expired) until its request is forgotten.
      const redelivered =
        state.kind === 'approved' &&
        state.redeliverUntil !== undefined &&
        state.redeliverUntil <= now;
      if (redelivered || request.expiresAt + FINISHED_RETENTION_MS <= now) this.forget(request);
    }
  }
}

/** Counts failures only: a user who mistypes 10 codes in an hour waits (brute-force bound). */
export class FailureLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  blocked(key: string): boolean {
    const window = this.windows.get(key);
    if (window === undefined) return false;
    if (this.now() - window.startedAt >= this.windowMs) {
      this.windows.delete(key);
      return false;
    }
    return window.count >= this.limit;
  }

  fail(key: string): void {
    const now = this.now();
    const window = this.windows.get(key);
    if (window === undefined || now - window.startedAt >= this.windowMs) {
      if (this.windows.size >= 10_000) this.windows.clear();
      this.windows.set(key, { startedAt: now, count: 1 });
    } else {
      window.count += 1;
    }
  }
}
