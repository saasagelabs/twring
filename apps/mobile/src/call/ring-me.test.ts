import type { CallState } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PendingMessage } from '@/threads/outbox';

import { askToRing, canAskToRing, RING_ME_TEXT, ringRequestState } from './ring-me';

const ended: CallState = { status: 'ENDED', callId: 'call_1' };
const base = {
  call: ended,
  connectedAt: 1_000,
  agent: { protocol: 'cord-connector' as const },
  chatsAvailable: true,
};

function pending(clientId: string, state: PendingMessage['state'], error?: unknown) {
  return [
    { clientId, agentId: 'agt_1', text: RING_ME_TEXT, state, createdAt: '', error },
  ] satisfies PendingMessage[];
}

describe('canAskToRing', () => {
  it('offers it after a normal end for agents that can ring', () => {
    expect(canAskToRing(base)).toBe(true);
    expect(canAskToRing({ ...base, agent: { protocol: 'mcp-app' } })).toBe(true);
  });

  it('hides it after a failed or never-connected call', () => {
    const failed: CallState = {
      status: 'FAILED',
      error: { code: 'GATEWAY_UNAVAILABLE', message: 'x', retryable: true },
    };
    expect(canAskToRing({ ...base, call: failed })).toBe(false);
    expect(canAskToRing({ ...base, connectedAt: undefined })).toBe(false);
  });

  it('hides it for agents that cannot ring, removed computers, or no chats', () => {
    expect(canAskToRing({ ...base, agent: { protocol: 'openai-chat' } })).toBe(false);
    expect(canAskToRing({ ...base, agent: undefined })).toBe(false);
    expect(
      canAskToRing({ ...base, agent: { protocol: 'cord-connector', connector_removed: true } }),
    ).toBe(false);
    expect(canAskToRing({ ...base, chatsAvailable: false })).toBe(false);
  });
});

describe('ring request', () => {
  it('sends the exact text once, ignoring double taps', () => {
    const send = vi.fn(() => 'c1');
    const first = askToRing(undefined, send);
    const second = askToRing(first, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      "Please carry on with what we talked about, and ring me when it's done.",
    );
    expect(second).toBe('c1');
  });

  it('moves from idle to asked, and shows a permanent failure', () => {
    expect(ringRequestState(undefined, []).kind).toBe('idle');
    expect(ringRequestState('c1', pending('c1', 'sending')).kind).toBe('asked');
    expect(ringRequestState('c1', []).kind).toBe('asked');
    const error = new Error('no');
    expect(ringRequestState('c1', pending('c1', 'failed', error))).toEqual({
      kind: 'failed',
      error,
    });
    expect(ringRequestState('c1', pending('other', 'failed')).kind).toBe('asked');
  });
});
