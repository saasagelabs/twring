import { createHash, randomBytes, randomInt } from 'node:crypto';

import { PAIRING_CODE_ALPHABET } from '@twring/contracts';

/** How long a pairing code works. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** Open codes one user may hold at once; older ones are dropped first. */
export const MAX_PENDING_PAIRINGS_PER_USER = 3;
/** Finished pairings are remembered this long so the app's poll can see the result. */
const CLAIMED_RETENTION_MS = 10 * 60_000;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function randomId(prefix: string): string {
  let out = '';
  for (const byte of randomBytes(20)) out += ID_ALPHABET[byte & 31];
  return `${prefix}_${out}`;
}

export const newConnectorId = (): string => randomId('con');
export const newPairingId = (): string => randomId('pair');
export const newChannelId = (): string => randomId('ch');

/** `XXXX-XXXX` from an alphabet without look-alikes: about 40 bits, single use, 10 minutes. */
export function newPairingCode(): string {
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
    if (i === 3) out += '-';
  }
  return out;
}

/** 256 random bits. Shown once to the connector; only its hash is kept. */
export function newConnectorToken(): string {
  return `cct_${randomBytes(32).toString('base64url')}`;
}

export function hashConnectorToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface Pairing {
  pairingId: string;
  userId: string;
  code: string;
  expiresAt: number;
  /** Set once claimed; the code can never be used again. */
  connectorId?: string;
  /**
   * Self-hosted: minted by the server's own admin listener (the installer's link), so the claim
   * adds the advertised agents to the person's list. A code the phone made never sets this.
   */
  autoAgents?: true;
}

/**
 * Pairing codes, in memory: they live 10 minutes, so a restart only means asking for a new code
 * (single gateway process, BACKEND_SPEC §1). A code is removed the moment it is claimed.
 */
export class PairingBook {
  private readonly byCode = new Map<string, Pairing>();
  private readonly byId = new Map<string, Pairing>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(userId: string, options: { autoAgents?: boolean } = {}): Pairing {
    this.sweep();
    const mine = [...this.byId.values()]
      .filter((p) => p.userId === userId && p.connectorId === undefined)
      .sort((a, b) => a.expiresAt - b.expiresAt);
    while (mine.length >= MAX_PENDING_PAIRINGS_PER_USER) this.forget(mine.shift()!);
    let code = newPairingCode();
    while (this.byCode.has(code)) code = newPairingCode();
    const pairing: Pairing = {
      pairingId: newPairingId(),
      userId,
      code,
      expiresAt: this.now() + PAIRING_TTL_MS,
      ...(options.autoAgents === true && { autoAgents: true as const }),
    };
    this.byCode.set(code, pairing);
    this.byId.set(pairing.pairingId, pairing);
    return pairing;
  }

  /**
   * Takes a code out of circulation and returns its pairing, or undefined when it is unknown or
   * expired. The caller then calls `completed` (or `failed`, which does not bring the code back).
   */
  take(code: string): Pairing | undefined {
    const pairing = this.byCode.get(code);
    if (pairing === undefined) return undefined;
    this.byCode.delete(code);
    if (pairing.expiresAt <= this.now()) {
      this.byId.delete(pairing.pairingId);
      return undefined;
    }
    return pairing;
  }

  /** The open, unexpired pairing for a code, without taking it out of circulation. */
  peek(code: string): Pairing | undefined {
    const pairing = this.byCode.get(code);
    return pairing === undefined || pairing.expiresAt <= this.now() ? undefined : pairing;
  }

  completed(pairing: Pairing, connectorId: string): void {
    pairing.connectorId = connectorId;
    // Keep it visible to the app's poll for a while after its own expiry.
    pairing.expiresAt = Math.max(pairing.expiresAt, this.now() + CLAIMED_RETENTION_MS);
  }

  /** The user's own pairing only. */
  get(userId: string, pairingId: string): Pairing | undefined {
    const pairing = this.byId.get(pairingId);
    return pairing?.userId === userId ? pairing : undefined;
  }

  isExpired(pairing: Pairing): boolean {
    return pairing.connectorId === undefined && pairing.expiresAt <= this.now();
  }

  /** Drops every code of a user (their data was deleted). */
  forgetUser(userId: string): void {
    for (const pairing of [...this.byId.values()]) {
      if (pairing.userId === userId) this.forget(pairing);
    }
  }

  private forget(pairing: Pairing): void {
    this.byId.delete(pairing.pairingId);
    if (this.byCode.get(pairing.code) === pairing) this.byCode.delete(pairing.code);
  }

  private sweep(): void {
    const now = this.now();
    for (const pairing of [...this.byId.values()]) {
      if (pairing.expiresAt + CLAIMED_RETENTION_MS <= now) this.forget(pairing);
    }
  }
}
