import type { AdapterCapabilities, AgentEvent, UserTurn } from '@twring/contracts';

import type { TwringAgentAdapter } from './adapter';

const CAPABILITIES: AdapterCapabilities = {
  streamingText: false,
  cancellation: false,
  resumableStream: false,
  activityEvents: false,
  toolEvents: false,
  approvals: false,
  conversationResume: false,
  serverInitiatedCalls: false,
};

/**
 * Speech-accuracy test line: answers every turn with exactly what it heard, immediately and in
 * one piece, so what you hear back is the recognizer's output and nothing else.
 */
export class RepeatAgentAdapter implements TwringAgentAdapter {
  readonly name = 'repeat';
  readonly capabilities = CAPABILITIES;

  connect(): Promise<void> {
    return Promise.resolve();
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- the interface is a stream
  async *sendTurn(turn: UserTurn): AsyncIterable<AgentEvent> {
    const ids = (n: number) => ({ event_id: `evt_${n}`, turn_id: turn.turnId, seq: n });
    const messageId = `msg_${turn.turnId}`;
    yield { type: 'text.start', ...ids(1), message_id: messageId };
    yield {
      type: 'text.delta',
      ...ids(2),
      message_id: messageId,
      delta: `You said: ${turn.text.trim()}`,
    };
    yield { type: 'text.end', ...ids(3), message_id: messageId };
    yield { type: 'done', ...ids(4), status: 'completed' };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
