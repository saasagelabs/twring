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
