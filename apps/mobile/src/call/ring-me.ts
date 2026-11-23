import type { Agent, CallState } from '@twring/contracts';

import type { PendingMessage } from '@/threads/outbox';

/** Sent as an ordinary chat message; the agent decides whether and when to ring (ADR-024). */
export const RING_ME_TEXT =
  "Please carry on with what we talked about, and ring me when it's done.";

/**
 * Agents that will act on the request soon after the call: those on the user's computer
 * (`cord-connector`), where the gateway runs a chat message as an agent turn and the agent has
 * `ring_me`. AI app contacts (`mcp-app`) are left out: they cannot take calls, and a chat message
 * to them waits until the app happens to call `check_replies`. Other protocols cannot ring.
 */
const RINGING_PROTOCOLS: ReadonlySet<Agent['protocol']> = new Set(['cord-connector']);

/** Offer "Ring me when it's done" only after a call that connected and ended normally. */
export function canAskToRing(input: {
  call: CallState;
  connectedAt: number | undefined;
  agent: Pick<Agent, 'protocol' | 'connector_removed'> | undefined;
  chatsAvailable: boolean;
}): boolean {
  const { call, connectedAt, agent, chatsAvailable } = input;
  return (
    call.status === 'ENDED' &&
    connectedAt !== undefined &&
    chatsAvailable &&
    agent !== undefined &&
    agent.connector_removed !== true &&
    RINGING_PROTOCOLS.has(agent.protocol)
  );
}

export type RingRequestState =
  { kind: 'idle' } | { kind: 'asked' } | { kind: 'failed'; error: unknown };

/**
 * Where the request stands. Queued or sending counts as asked: the outbox retries on its own, and
 * a message that left the outbox was delivered. Only a permanent failure shows an error.
 */
export function ringRequestState(
  clientId: string | undefined,
  pending: readonly PendingMessage[],
): RingRequestState {
  if (clientId === undefined) return { kind: 'idle' };
  const item = pending.find((message) => message.clientId === clientId);
  if (item?.state === 'failed') return { kind: 'failed', error: item.error };
  return { kind: 'asked' };
}

/**
 * Sends the request at most once. `sent` is a ref, not render state, so two taps handled before
 * the next render (same stale closure) still send one message.
 */
export function askToRing(
  sent: { current: string | undefined },
  send: (text: string) => string | undefined,
): string | undefined {
  if (sent.current !== undefined) return sent.current;
  sent.current = send(RING_ME_TEXT);
  return sent.current;
}
