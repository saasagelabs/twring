import type { CreateCallResponse } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { InviteAnswer } from '@/api/client';

import { ApiError } from '../api/client';

import type { RingPush } from './protocol';
import { answerSystemRing, type SystemAnswerDeps } from './system-answer';

const push: RingPush = {
  type: 'cord.ring',
  invite_id: 'inv_1',
  agent_id: 'agt_1',
  agent_name: 'Hermes',
  expires_at: '2026-10-20T12:00:30.000Z',
  server_time: '2026-10-20T12:00:00.000Z',
} as RingPush;

const session = { call_id: 'call_1' } as unknown as CreateCallResponse;
const source = { uri: 'https://api.twring.com/speech', headers: { authorization: 'Bearer x' } };

function deps(answer: () => Promise<InviteAnswer>, overrides: Partial<SystemAnswerDeps> = {}) {
  const fns = {
    answerInvite: vi.fn(answer),
    latestAgentMessage: vi.fn(() => Promise.resolve<string | undefined>('msg_1')),
    speechSource: vi.fn(() => Promise.resolve(source)),
    speakThenEnd: vi.fn(),
    endSystemCall: vi.fn(),
    joinCall: vi.fn(),
    showWhenActive: vi.fn(),
    notify: vi.fn(),
  };
  return { fns, deps: { ...fns, ...overrides } satisfies SystemAnswerDeps };
}

describe('answerSystemRing', () => {
  it('joins an agent call without drawing, and opens the call screen when the app is in front', async () => {
    const { fns, deps: d } = deps(() => Promise.resolve({ mode: 'call', session }));
    await answerSystemRing(push, d);
    expect(fns.answerInvite).toHaveBeenCalledWith('inv_1');
    expect(fns.joinCall).toHaveBeenCalledWith({ agentId: 'agt_1', name: 'Hermes' }, session);
    expect(fns.showWhenActive).toHaveBeenCalledWith({
      pathname: '/call',
      params: { agentId: 'agt_1', name: 'Hermes' },
    });
    expect(fns.endSystemCall).not.toHaveBeenCalled();
  });

  it("reads an AI app's message out on the system call, then opens its chat", async () => {
    const { fns, deps: d } = deps(() => Promise.resolve({ mode: 'chat', agentId: 'agt_2' }));
    await answerSystemRing(push, d);
    expect(fns.latestAgentMessage).toHaveBeenCalledWith('agt_2');
    expect(fns.speechSource).toHaveBeenCalledWith('agt_2', 'msg_1');
    expect(fns.speakThenEnd).toHaveBeenCalledWith(source);
    expect(fns.endSystemCall).not.toHaveBeenCalled();
    expect(fns.showWhenActive).toHaveBeenCalledWith({
      pathname: '/chats/[agentId]',
      params: { agentId: 'agt_2' },
    });
  });

  it('ends the system call and lets the chat read it out when there is nothing to speak', async () => {
    const { fns, deps: d } = deps(() => Promise.resolve({ mode: 'chat', agentId: 'agt_2' }), {
      latestAgentMessage: () => Promise.resolve(undefined),
    });
    await answerSystemRing(push, d);
    expect(fns.speakThenEnd).not.toHaveBeenCalled();
    expect(fns.endSystemCall).toHaveBeenCalledOnce();
    expect(fns.showWhenActive).toHaveBeenCalledWith({
      pathname: '/chats/[agentId]',
      params: { agentId: 'agt_2', listen: '1' },
    });
  });

  it('ends the system call when the message cannot be fetched', async () => {
    const { fns, deps: d } = deps(() => Promise.resolve({ mode: 'chat', agentId: 'agt_2' }), {
      speechSource: () => Promise.reject(new Error('offline')),
    });
    await answerSystemRing(push, d);
    expect(fns.speakThenEnd).not.toHaveBeenCalled();
    expect(fns.endSystemCall).toHaveBeenCalledOnce();
    expect(fns.showWhenActive).toHaveBeenCalledOnce();
  });

  it('ends the system call when the answer fails (taken elsewhere, expired, offline)', async () => {
    const { fns, deps: d } = deps(() => Promise.reject(new Error('invite_not_ringing')));
    await answerSystemRing(push, d);
    expect(fns.endSystemCall).toHaveBeenCalledOnce();
    expect(fns.joinCall).not.toHaveBeenCalled();
    expect(fns.showWhenActive).not.toHaveBeenCalled();
  });

  it('tells the person why when the call was refused (computer offline)', async () => {
    const { fns, deps: d } = deps(() =>
      Promise.reject(new ApiError('http', 'agent_offline', 'req-1', undefined, 409)),
    );
    await answerSystemRing(push, d);
    expect(fns.endSystemCall).toHaveBeenCalledOnce();
    expect(fns.notify).toHaveBeenCalledWith(
      "Twring couldn't connect your call",
      "Your computer is offline. Make sure it's on and online, then call again.",
    );
  });

  it('says nothing when the ring was answered on another phone', async () => {
    const { fns, deps: d } = deps(() =>
      Promise.reject(new ApiError('http', 'invite_already_handled', 'req-2', undefined, 409)),
    );
    await answerSystemRing(push, d);
    expect(fns.endSystemCall).toHaveBeenCalledOnce();
    expect(fns.notify).not.toHaveBeenCalled();
  });
});
