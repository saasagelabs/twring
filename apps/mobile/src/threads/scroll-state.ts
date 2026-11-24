import type { ThreadMessage } from '@twring/contracts';

/** Closer than this to the newest message counts as reading the bottom. */
export const AT_BOTTOM_PX = 48;

/** An agent reply as the pill sees it: its id and where it sits in the thread. */
export interface Reply {
  id: string;
  seq: number;
}

/**
 * What the "New reply" pill knows. `baseline` holds the agent replies already on screen when the
 * reader left the bottom, and `newestSeq` the newest of them; only a reply after it is new, so
 * older pages loaded while scrolling into history never count. Undefined while at the bottom.
 */
export interface PillState {
  baseline: ReadonlySet<string> | undefined;
  newestSeq: number;
  count: number;
  show: boolean;
}

export const initialPill: PillState = {
  baseline: undefined,
  newestSeq: -Infinity,
  count: 0,
  show: false,
};

/** Agent replies: the only arrivals the pill counts. */
export function replyIds(messages: readonly ThreadMessage[]): Reply[] {
  return messages
    .filter((message) => message.kind === 'agent_text')
    .map((message) => ({ id: message.id, seq: message.seq }));
}

/**
 * Next pill state after a scroll or a change in messages. Counting by id means a reply that grows
 * while it streams, or one a reconnect replays, counts once; a deleted or cleared reply stops
 * counting. The pill shows only when the reader is more than a screen away from the bottom.
 */
export function nextPill(
  previous: PillState,
  input: { ids: readonly Reply[]; distanceFromBottom: number; viewportHeight: number },
): PillState {
  if (input.distanceFromBottom <= AT_BOTTOM_PX) return initialPill;
  const fresh = new Set<string>();
  let { baseline, newestSeq } = previous;
  if (!baseline) {
    baseline = new Set(input.ids.map((reply) => reply.id));
    newestSeq = Math.max(-Infinity, ...input.ids.map((reply) => reply.seq));
  }
  for (const reply of input.ids)
    if (!baseline.has(reply.id) && reply.seq > newestSeq) fresh.add(reply.id);
  const count = fresh.size;
  const show = count > 0 && input.distanceFromBottom > input.viewportHeight;
  if (baseline === previous.baseline && count === previous.count && show === previous.show)
    return previous;
  return { baseline, newestSeq, count, show };
}

/** Screen readers hear the pill once per burst: when it appears, not for every reply after. */
export function shouldAnnounce(previous: PillState, next: PillState): boolean {
  return !previous.show && next.show;
}

export function pillLabel(count: number): string {
  return count === 1 ? 'New reply' : `${count} new replies`;
}

/**
 * The first agent message the reader has not seen, from the read marker taken when the chat
 * opened. Undefined when everything is read or the chat is empty: the chat opens at the bottom.
 */
export function firstUnreadSeq(
  messages: readonly ThreadMessage[],
  readSeq: number | undefined,
): number | undefined {
  if (readSeq === undefined) return undefined;
  return messages.find((message) => message.kind !== 'user_text' && message.seq > readSeq)?.seq;
}
