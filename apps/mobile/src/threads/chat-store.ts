import type { ThreadMessage, ThreadSocketFrame } from '@twring/contracts';

export interface ChatState {
  messages: ThreadMessage[];
  maxRev: number;
  hasOlder: boolean;
  progress?: { messageId: string; text: string; activity?: string };
}

export function emptyChat(): ChatState {
  return { messages: [], maxRev: 0, hasOlder: false };
}

const finalStatuses = new Set(['answered', 'failed', 'stopped', 'interrupted', 'expired']);

export function upsert(state: ChatState, incoming: readonly ThreadMessage[]): ChatState {
  if (!incoming.length) return state;
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  let maxRev = state.maxRev;
  let progress = state.progress;
  for (const message of incoming) {
    maxRev = Math.max(maxRev, message.rev);
    const previous = byId.get(message.id);
    if (previous && previous.rev >= message.rev) continue;
    byId.set(message.id, message);
  }
  if (progress) {
    const user = byId.get(progress.messageId);
    if (
      user?.kind === 'user_text' &&
      (finalStatuses.has(user.status) ||
        (user.turn_id &&
          [...byId.values()].some(
            (message) => message.kind === 'agent_text' && message.turn_id === user.turn_id,
          )))
    )
      progress = undefined;
  }
  return {
    ...state,
    messages: [...byId.values()].sort((a, b) => a.seq - b.seq),
    maxRev,
    ...(progress ? { progress } : { progress: undefined }),
  };
}

export function applyFrame(state: ChatState, agentId: string, frame: ThreadSocketFrame): ChatState {
  if (frame.type === 'message.upserted')
    return frame.message.agent_id === agentId ? upsert(state, [frame.message]) : state;
  if (frame.agent_id !== agentId) return state;
  if (frame.type === 'thread.cleared') return { ...emptyChat(), maxRev: state.maxRev };
  if (frame.type === 'message.deleted')
    return {
      ...state,
      messages: state.messages.filter((message) => message.id !== frame.message_id),
      ...(state.progress?.messageId === frame.message_id && { progress: undefined }),
    };
  const user = state.messages.find((message) => message.id === frame.message_id);
  if (
    user?.kind === 'user_text' &&
    (finalStatuses.has(user.status) ||
      (user.turn_id &&
        state.messages.some(
          (message) => message.kind === 'agent_text' && message.turn_id === user.turn_id,
        )))
  )
    return state;
  return {
    ...state,
    progress: {
      messageId: frame.message_id,
      text: frame.text,
      ...(frame.activity ? { activity: frame.activity } : {}),
    },
  };
}

/**
 * Applies the newest page on opening a chat. When older messages exist and the page does not
 * reach the cached ones, the cache is replaced so older pages load down from the page's oldest
 * message instead of skipping the messages in between.
 */
export function openLatest(
  state: ChatState,
  page: { messages: readonly ThreadMessage[]; hasMore: boolean },
): ChatState {
  const newestCached = state.messages.at(-1)?.seq;
  const oldest = page.messages.length ? Math.min(...page.messages.map((m) => m.seq)) : undefined;
  const gap =
    page.hasMore && newestCached !== undefined && oldest !== undefined && oldest > newestCached + 1;
  return upsert(gap ? { ...state, messages: [] } : state, page.messages);
}

/**
 * Applies a fresh newest page: messages it no longer holds were deleted (a delete does not bump
 * rev, so catch-up cannot report it). Only the range the page covers is pruned, never a message
 * newer than both the page and `knownSeq` (the newest seq when the request went out).
 */
export function replaceLatest(
  state: ChatState,
  page: { messages: readonly ThreadMessage[]; hasMore: boolean },
  knownSeq: number,
): ChatState {
  const ids = new Set(page.messages.map((message) => message.id));
  const seqs = page.messages.map((message) => message.seq);
  if (page.hasMore && !seqs.length) return state;
  const floor = page.hasMore ? Math.min(...seqs) : -Infinity;
  const ceiling = Math.max(knownSeq, ...seqs);
  const kept = state.messages.filter(
    (message) => message.seq < floor || message.seq > ceiling || ids.has(message.id),
  );
  const progressId = state.progress?.messageId;
  const progressGone =
    state.messages.some((message) => message.id === progressId) &&
    !kept.some((message) => message.id === progressId);
  const progress = progressGone ? undefined : state.progress;
  const pruned =
    kept.length === state.messages.length && progress === state.progress
      ? state
      : { ...state, messages: kept, progress };
  return upsert(pruned, page.messages);
}
