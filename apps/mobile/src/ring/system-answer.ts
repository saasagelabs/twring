import type { CreateCallResponse } from '@twring/contracts';

import type { InviteAnswer } from '@/api/client';

import { ApiError } from '../api/client';
import { apiErrorCopy } from '../api/errors';

import type { RingPush } from './protocol';

/**
 * iOS: a ring answered on the system call screen. The app may be in the
 * background, even behind the lock screen, so nothing is drawn here: the call starts (or the AI
 * app's message is read out on the system call) at once, and the screen to show waits until the
 * app is in front. Opening a screen from the background left a black screen.
 */

export type AnsweredRoute =
  | { pathname: '/call'; params: { agentId?: string; name?: string } }
  | { pathname: '/chats/[agentId]'; params: { agentId: string; listen?: '1' } };

export interface SystemAnswerDeps {
  answerInvite(inviteId: string): Promise<InviteAnswer>;
  /** The newest agent message in the chat: the AI app's reason for ringing. */
  latestAgentMessage(agentId: string): Promise<string | undefined>;
  speechSource(
    agentId: string,
    messageId: string,
  ): Promise<{ uri: string; headers: Record<string, string> }>;
  /** Reads the audio out on the system call, then ends it. */
  speakThenEnd(source: { uri: string; headers: Record<string, string> }): void;
  endSystemCall(): void;
  /** Joins the answered call without opening its screen. */
  joinCall(target: { agentId?: string; name?: string }, session: CreateCallResponse): void;
  /** Opens the screen now if the app is in front, or as soon as it is. */
  showWhenActive(route: AnsweredRoute): void;
  /** Posts a notification: the system call ended before the app could say why. */
  notify(title: string, body: string): void;
}

export const REFUSED_TITLE = "Twring couldn't connect your call";

export async function answerSystemRing(push: RingPush, deps: SystemAnswerDeps): Promise<void> {
  let answer: InviteAnswer;
  try {
    answer = await deps.answerInvite(push.invite_id);
  } catch (error) {
    // The system call has nothing to join. Answered on another phone is fine as it is; anything
    // else (computer offline, daily limit, no internet) gets a notification saying why, since
    // the system call screen just closes.
    deps.endSystemCall();
    if (!(error instanceof ApiError && error.code === 'invite_already_handled')) {
      deps.notify(REFUSED_TITLE, apiErrorCopy(error).message);
    }
    return;
  }
  if (answer.mode === 'call') {
    const target = {
      ...(push.agent_id !== undefined && { agentId: push.agent_id }),
      ...(push.agent_name !== undefined && { name: push.agent_name }),
    };
    deps.joinCall(target, answer.session);
    deps.showWhenActive({ pathname: '/call', params: target });
    return;
  }
  const { agentId } = answer;
  let spoken = false;
  try {
    const messageId = await deps.latestAgentMessage(agentId);
    if (messageId !== undefined) {
      deps.speakThenEnd(await deps.speechSource(agentId, messageId));
      spoken = true;
    }
  } catch {
    // Falls through: the chat reads it out when opened.
  }
  if (!spoken) deps.endSystemCall();
  deps.showWhenActive({
    pathname: '/chats/[agentId]',
    params: spoken ? { agentId } : { agentId, listen: '1' },
  });
}
