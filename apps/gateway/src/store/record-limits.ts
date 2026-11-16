/**
 * Per-account ceilings on stored rows. Every row lives in one JSON file that is rewritten on each
 * change, so a script creating agents or computers without end would slow every account. The
 * ceilings sit far above real use (the most anyone had on 2026-11-17: 6 agents, 10 computers).
 * Checked inside the collection's update, so parallel creates cannot pass them.
 */
export const MAX_AGENTS_PER_USER = 50;
export const MAX_CONNECTORS_PER_USER = 25;

export type RecordLimitKind = 'agents' | 'computers';

const MESSAGES: Readonly<Record<RecordLimitKind, string>> = {
  agents: `You can have up to ${MAX_AGENTS_PER_USER} agents. Remove one to add another.`,
  computers: `You can link up to ${MAX_CONNECTORS_PER_USER} computers. Remove one to link another.`,
};

/** A create refused because the account is at its ceiling. The message is safe to show. */
export class RecordLimitError extends Error {
  readonly statusCode = 409;
  /** Wire error code; `kind` says which ceiling. */
  readonly code = 'account_limit_reached';

  constructor(readonly kind: RecordLimitKind) {
    super(MESSAGES[kind]);
    this.name = 'RecordLimitError';
  }
}

/** Throws when `userId` already has `max` of `items`. */
export function assertBelowLimit(
  items: readonly { user_id: string }[],
  userId: string,
  max: number,
  kind: RecordLimitKind,
): void {
  let count = 0;
  for (const row of items) if (row.user_id === userId) count += 1;
  if (count >= max) throw new RecordLimitError(kind);
}
