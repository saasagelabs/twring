import { CALL_TRANSCRIPT_HOLD_MS, type CallTranscript } from '@twring/contracts';

/** Most call transcripts held at once; past it, the oldest goes. */
export const MAX_HELD_CALL_TRANSCRIPTS = 1000;

export interface HeldCallTranscript {
  userId: string;
  agentId: string;
  transcript: CallTranscript;
  expiresAt: number;
}

/**
 * A finished call's transcript, held in memory for CALL_TRANSCRIPT_HOLD_MS so the person can still
 * send it to the chat from the call-ended screen (ADR-050). Never written to disk or logged.
 */
export class CallTranscriptHold {
  private readonly held = new Map<string, HeldCallTranscript>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly holdMs = CALL_TRANSCRIPT_HOLD_MS,
    private readonly max = MAX_HELD_CALL_TRANSCRIPTS,
  ) {}

  put(callId: string, entry: Omit<HeldCallTranscript, 'expiresAt'>): void {
    this.sweep();
    this.held.delete(callId);
    this.held.set(callId, { ...entry, expiresAt: this.now() + this.holdMs });
    while (this.held.size > this.max) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined) break;
      this.held.delete(oldest);
    }
  }

  /** This user's held transcript for `callId`, if it has not expired. */
  get(userId: string, callId: string): HeldCallTranscript | undefined {
    const entry = this.held.get(callId);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.held.delete(callId);
      return undefined;
    }
    return entry.userId === userId ? entry : undefined;
  }

  delete(callId: string): void {
    this.held.delete(callId);
  }

  /** Drops everything held for `userId` (and, with `agentId`, only that agent's calls). */
  deleteFor(userId: string, agentId?: string): void {
    for (const [callId, entry] of this.held)
      if (entry.userId === userId && (agentId === undefined || entry.agentId === agentId))
        this.held.delete(callId);
  }

  clear(): void {
    this.held.clear();
  }

  get size(): number {
    return this.held.size;
  }

  /** Expired entries go; insertion order is expiry order, so the scan stops at the first live. */
  private sweep(): void {
    const now = this.now();
    for (const [callId, entry] of this.held) {
      if (entry.expiresAt > now) break;
      this.held.delete(callId);
    }
  }
}
