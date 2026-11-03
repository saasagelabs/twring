import { ApiError } from '../api/client';
import { apiErrorCopy, type ErrorCopy } from '../api/errors';

import { INVITE_ALREADY_HANDLED, INVITE_EXPIRED, type Invite, type RingPush } from './protocol';

/** An incoming ring as the phone shows it; `expiresAt` is on this phone's clock (ms). */
export interface IncomingInvite {
  inviteId: string;
  agentId: string;
  agentName: string;
  reason: string;
  expiresAt: number;
}

/** Why the incoming-call screen stopped ringing. */
export type EndedWhy =
  'expired' | 'answered_elsewhere' | 'declined' | 'cancelled' | 'missed' | 'not_found';

export type IncomingState =
  | { phase: 'loading' }
  | { phase: 'ringing' }
  | { phase: 'answering' }
  | { phase: 'declining' }
  | { phase: 'ended'; why: EndedWhy }
  /** Answering failed for an ordinary call reason (busy line, limit, computer offline). */
  | { phase: 'failed'; error: ErrorCopy };

export type IncomingEvent =
  /** `GET /v1/invites/:id` answered with this status. */
  | { type: 'LOADED'; status: string }
  | { type: 'LOAD_FAILED'; error: unknown }
  /** The clock moved; ends the ring once `now` passes `expiresAt`. */
  | { type: 'TICK'; now: number; expiresAt: number }
  /** `cord.ring_cancel` for this invite. */
  | { type: 'CANCELLED'; status: string }
  | { type: 'ANSWER' }
  | { type: 'ANSWER_FAILED'; error: unknown }
  | { type: 'DECLINE' }
  /** The decline was sent, or no longer needed (already handled or expired). */
  | { type: 'DECLINE_DONE' };

export const INITIAL_INCOMING: IncomingState = { phase: 'loading' };

/**
 * `expires_at` moved onto the phone's clock: the server says how long is left
 * (`expires_at - server_time`), counted from when the answer arrived.
 */
export function expiryOnPhone(expiresAt: string, serverTime: string, receivedAt: number): number {
  const remaining = Date.parse(expiresAt) - Date.parse(serverTime);
  if (!Number.isFinite(remaining)) {
    const absolute = Date.parse(expiresAt);
    return Number.isFinite(absolute) ? absolute : receivedAt;
  }
  return receivedAt + remaining;
}

export function inviteFrom(source: Invite | RingPush, receivedAt: number): IncomingInvite {
  return {
    inviteId: source.invite_id,
    agentId: source.agent_id,
    agentName: source.agent_name.trim() || 'Your agent',
    reason: source.reason.trim(),
    expiresAt: expiryOnPhone(source.expires_at, source.server_time, receivedAt),
  };
}

/** Whole seconds left to answer, never negative. */
export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** The screen for an invite the server reports in `status`. */
function phaseForStatus(status: string): IncomingState {
  switch (status) {
    case 'pending':
      return { phase: 'ringing' };
    case 'answered':
      return { phase: 'ended', why: 'answered_elsewhere' };
    case 'declined':
      return { phase: 'ended', why: 'declined' };
    case 'missed':
      return { phase: 'ended', why: 'missed' };
    default:
      return { phase: 'ended', why: 'cancelled' };
  }
}

/** What an answer failure means: the ring is over (410/409/404), or an ordinary call error. */
export function answerFailure(error: unknown): IncomingState {
  if (error instanceof ApiError && error.kind === 'http') {
    const code = error.code as string | undefined;
    if (error.status === 410 || code === INVITE_EXPIRED) return { phase: 'ended', why: 'expired' };
    if (error.status === 404 || code === 'not_found') return { phase: 'ended', why: 'not_found' };
    // A 409 with a code this build knows (`call_in_progress`, `agent_offline`) is an ordinary
    // call error the caller can fix and retry; an unknown one is the invite being handled.
    if (code === INVITE_ALREADY_HANDLED || (error.status === 409 && code === undefined)) {
      return { phase: 'ended', why: 'answered_elsewhere' };
    }
  }
  return { phase: 'failed', error: apiErrorCopy(error) };
}

export function reduceIncoming(state: IncomingState, event: IncomingEvent): IncomingState {
  if (state.phase === 'ended') return state;
  switch (event.type) {
    case 'LOADED':
      // The server's word only matters before the user acted.
      if (state.phase !== 'loading' && state.phase !== 'ringing') return state;
      return phaseForStatus(event.status);
    case 'LOAD_FAILED': {
      if (state.phase !== 'loading') return state;
      const failure = answerFailure(event.error);
      // Unreachable server: ring on from the push details; answering will tell.
      return failure.phase === 'ended' ? failure : { phase: 'ringing' };
    }
    case 'TICK':
      if (state.phase !== 'loading' && state.phase !== 'ringing' && state.phase !== 'failed') {
        return state;
      }
      return event.now >= event.expiresAt ? { phase: 'ended', why: 'expired' } : state;
    case 'CANCELLED':
      // Our own answer or decline makes the server cancel the ring on every device: not news.
      if (state.phase === 'answering' || state.phase === 'declining') return state;
      return phaseForStatus(event.status === 'pending' ? 'cancelled' : event.status);
    case 'ANSWER':
      return state.phase === 'ringing' || state.phase === 'failed' ? { phase: 'answering' } : state;
    case 'ANSWER_FAILED':
      return state.phase === 'answering' ? answerFailure(event.error) : state;
    case 'DECLINE':
      return state.phase === 'ringing' || state.phase === 'failed' || state.phase === 'loading'
        ? { phase: 'declining' }
        : state;
    case 'DECLINE_DONE':
      return state.phase === 'declining' ? { phase: 'ended', why: 'declined' } : state;
  }
}

/** Headline and detail once the ring is over. */
export function endedCopy(why: EndedWhy): { title: string; detail: string } {
  switch (why) {
    case 'expired':
    case 'missed':
      return { title: 'Missed call', detail: "It's in your call history. You can call back." };
    case 'answered_elsewhere':
      return { title: 'Answered on another device', detail: 'Nothing to do here.' };
    case 'declined':
      return { title: 'Call declined', detail: 'Your agent was told.' };
    case 'cancelled':
      return { title: 'Your agent hung up', detail: 'It stopped calling before you answered.' };
    case 'not_found':
      return { title: 'This call is gone', detail: 'It may have ended already.' };
  }
}
