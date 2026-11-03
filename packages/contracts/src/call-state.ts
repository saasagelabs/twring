import { z } from 'zod';

/**
 * Call state machine (docs/CALL_STATE_MACHINE.md). Pure and deterministic so mobile and gateway
 * share one definition and it can be table-tested.
 *
 * Once connected, the conversational states (LISTENING, USER_SPEAKING, AGENT_WORKING,
 * AGENT_SPEAKING) mirror the gateway's floor, which is authoritative because the gateway is where
 * speech recognition, the agent, and speech synthesis meet (ADR-014). The phone applies the
 * gateway's latest floor with FLOOR_CHANGED. TURN_COMMITTING is not a separate phase with Flux:
 * its end-of-turn is the commit. INTERRUPTING arrives with barge-in (Milestone 4).
 */

/** Stable call failure codes (CALL_STATE_MACHINE §11). UI branches on `code`, never `message`. */
export const callErrorCodeSchema = z.enum([
  'CALL_AUTH_FAILED',
  'CALL_SESSION_CREATE_FAILED',
  'CALL_CAPACITY_EXCEEDED',
  /** Today's calling allowance is used up (refused at start, or ran out during the call). */
  'DAILY_LIMIT_REACHED',
  /** Today's calling for the whole service is used up (`service_busy`). */
  'SERVICE_BUSY',
  'LIVEKIT_CONNECT_FAILED',
  'GATEWAY_UNAVAILABLE',
  'AGENT_CONNECT_FAILED',
  /** The agent runs on the user's computer, which is not connected (ADR-023). */
  'AGENT_OFFLINE',
  /** The user's computer no longer offers this agent (ADR-023). */
  'AGENT_NOT_ON_COMPUTER',
  /** The computer this agent ran on was removed (revoked) from the account (ADR-023). */
  'CONNECTOR_REMOVED',
  /** The user already has a live call; one call at a time. */
  'CALL_IN_PROGRESS',
  'VOICE_UNAVAILABLE',
  'MIC_PERMISSION_DENIED',
  'MIC_UNAVAILABLE',
  'NETWORK_LOST',
  'RECONNECT_EXHAUSTED',
  'CALL_ENDED_BY_SERVER',
  'UNKNOWN_CALL_FAILURE',
  /**
   * The caller's own voice account refused their saved key during the call, or the saved key
   * could not be read when the call started.
   */
  'SPEECH_KEY_REFUSED',
  /** Self-hosted: Twring's audio service could not be reached (`audio_unavailable`). */
  'AUDIO_UNAVAILABLE',
  /** Self-hosted: the server's own call audio could not be reached (`audio_unreachable`). */
  'AUDIO_UNREACHABLE',
  'AUDIO_PAUSED',
  'AUDIO_EXPIRED',
  'AUDIO_LIMIT_REACHED',
]);
export type CallErrorCode = z.infer<typeof callErrorCodeSchema>;

export interface CallError {
  code: CallErrorCode;
  /** Safe to show a user. Never upstream/provider text. */
  message: string;
  retryable: boolean;
  /** Request or call ID a user can quote to support. */
  correlationId?: string;
}

/** Both halves must be up before the user is told the call is connected (§6). */
export interface Readiness {
  media: boolean;
  gateway: boolean;
}

/** Who has the conversational floor, as reported by the gateway. */
export type Floor =
  | { kind: 'listening' }
  | { kind: 'user_speaking' }
  /** `activity` is a short, safe label from the agent's own activity events, e.g. "Searching…". */
  | { kind: 'agent_working'; turnId: string; activity?: string }
  | { kind: 'agent_speaking'; turnId: string };

export type CallState =
  | { status: 'IDLE' }
  | { status: 'PREPARING' }
  | { status: 'CONNECTING'; callId: string; readiness: Readiness }
  | { status: 'LISTENING'; callId: string }
  | { status: 'USER_SPEAKING'; callId: string }
  | { status: 'AGENT_WORKING'; callId: string; turnId: string; activity?: string }
  | { status: 'AGENT_SPEAKING'; callId: string; turnId: string }
  | { status: 'RECONNECTING'; callId: string; readiness: Readiness }
  | { status: 'ENDING'; callId?: string }
  | { status: 'ENDED'; callId?: string }
  | { status: 'FAILED'; callId?: string; error: CallError };

export type CallStatus = CallState['status'];

export type CallEvent =
  | { type: 'START_REQUESTED' }
  | { type: 'SESSION_CREATED'; callId: string }
  | { type: 'MEDIA_CONNECTED' }
  | { type: 'GATEWAY_READY' }
  | { type: 'GATEWAY_LOST' }
  | { type: 'TRANSPORT_LOST' }
  | { type: 'TRANSPORT_RECOVERED' }
  | { type: 'FLOOR_CHANGED'; floor: Floor }
  | { type: 'END_REQUESTED' }
  | { type: 'FATAL_ERROR'; error: CallError }
  | { type: 'CLEANUP_COMPLETE' };

export type CallEventType = CallEvent['type'];

export interface Transition {
  state: CallState;
  /**
   * False when the event is not legal in the current state. The state is then unchanged; callers
   * emit a diagnostic in development and carry on (§13).
   */
  accepted: boolean;
}

export const INITIAL_CALL_STATE: CallState = { status: 'IDLE' };

const TERMINAL: ReadonlySet<CallStatus> = new Set(['ENDED', 'FAILED']);

export function isTerminal(state: CallState): boolean {
  return TERMINAL.has(state.status);
}

/** Connected and conversational: the states that mirror the gateway's floor. */
export type ConnectedState = Extract<
  CallState,
  { status: 'LISTENING' | 'USER_SPEAKING' | 'AGENT_WORKING' | 'AGENT_SPEAKING' }
>;

export function isConnected(state: CallState): state is ConnectedState {
  switch (state.status) {
    case 'LISTENING':
    case 'USER_SPEAKING':
    case 'AGENT_WORKING':
    case 'AGENT_SPEAKING':
      return true;
    case 'IDLE':
    case 'PREPARING':
    case 'CONNECTING':
    case 'RECONNECTING':
    case 'ENDING':
    case 'ENDED':
    case 'FAILED':
      return false;
  }
}

function floorState(callId: string, floor: Floor): ConnectedState {
  switch (floor.kind) {
    case 'listening':
      return { status: 'LISTENING', callId };
    case 'user_speaking':
      return { status: 'USER_SPEAKING', callId };
    case 'agent_working':
      return {
        status: 'AGENT_WORKING',
        callId,
        turnId: floor.turnId,
        ...(floor.activity !== undefined && { activity: floor.activity }),
      };
    case 'agent_speaking':
      return { status: 'AGENT_SPEAKING', callId, turnId: floor.turnId };
  }
}

/** Active = holds or is acquiring call resources that END_REQUESTED must release. */
export function isActive(state: CallState): boolean {
  return state.status !== 'IDLE' && !isTerminal(state);
}

function accept(state: CallState): Transition {
  return { state, accepted: true };
}

function reject(state: CallState): Transition {
  return { state, accepted: false };
}

/** CONNECTING and RECONNECTING both wait for media + gateway, then land in LISTENING. */
function withReadiness(
  state: Extract<CallState, { status: 'CONNECTING' | 'RECONNECTING' }>,
  patch: Partial<Readiness>,
): CallState {
  const readiness = { ...state.readiness, ...patch };
  if (readiness.media && readiness.gateway) return { status: 'LISTENING', callId: state.callId };
  return { ...state, readiness };
}

function fromPreparing(
  state: Extract<CallState, { status: 'PREPARING' }>,
  event: CallEvent,
): Transition {
  switch (event.type) {
    case 'SESSION_CREATED':
      return accept({
        status: 'CONNECTING',
        callId: event.callId,
        readiness: { media: false, gateway: false },
      });
    case 'END_REQUESTED':
      return accept({ status: 'ENDING' });
    case 'FATAL_ERROR':
      return accept({ status: 'FAILED', error: event.error });
    case 'START_REQUESTED':
    case 'MEDIA_CONNECTED':
    case 'GATEWAY_READY':
    case 'GATEWAY_LOST':
    case 'TRANSPORT_LOST':
    case 'TRANSPORT_RECOVERED':
    case 'FLOOR_CHANGED':
    case 'CLEANUP_COMPLETE':
      return reject(state);
  }
}

function fromConnecting(
  state: Extract<CallState, { status: 'CONNECTING' | 'RECONNECTING' }>,
  event: CallEvent,
): Transition {
  switch (event.type) {
    case 'MEDIA_CONNECTED':
    case 'TRANSPORT_RECOVERED':
      return accept(withReadiness(state, { media: true }));
    case 'GATEWAY_READY':
      return accept(withReadiness(state, { gateway: true }));
    case 'GATEWAY_LOST':
      return accept({ ...state, readiness: { ...state.readiness, gateway: false } });
    case 'TRANSPORT_LOST':
      return accept({
        status: 'RECONNECTING',
        callId: state.callId,
        readiness: { ...state.readiness, media: false },
      });
    case 'END_REQUESTED':
      return accept({ status: 'ENDING', callId: state.callId });
    case 'FATAL_ERROR':
      return accept({ status: 'FAILED', callId: state.callId, error: event.error });
    // Floor updates wait until the call is connected; the phone re-applies the latest one then.
    case 'FLOOR_CHANGED':
    case 'START_REQUESTED':
    case 'SESSION_CREATED':
    case 'CLEANUP_COMPLETE':
      return reject(state);
  }
}

function fromConnected(state: ConnectedState, event: CallEvent): Transition {
  switch (event.type) {
    case 'FLOOR_CHANGED':
      return accept(floorState(state.callId, event.floor));
    case 'TRANSPORT_LOST':
      return accept({
        status: 'RECONNECTING',
        callId: state.callId,
        readiness: { media: false, gateway: true },
      });
    case 'GATEWAY_LOST':
      return accept({
        status: 'RECONNECTING',
        callId: state.callId,
        readiness: { media: true, gateway: false },
      });
    // Repeated readiness signals (e.g. attribute replay after a resume) are harmless.
    case 'MEDIA_CONNECTED':
    case 'GATEWAY_READY':
    case 'TRANSPORT_RECOVERED':
      return accept(state);
    case 'END_REQUESTED':
      return accept({ status: 'ENDING', callId: state.callId });
    case 'FATAL_ERROR':
      return accept({ status: 'FAILED', callId: state.callId, error: event.error });
    case 'START_REQUESTED':
    case 'SESSION_CREATED':
    case 'CLEANUP_COMPLETE':
      return reject(state);
  }
}

function fromEnding(state: Extract<CallState, { status: 'ENDING' }>, event: CallEvent): Transition {
  switch (event.type) {
    case 'CLEANUP_COMPLETE':
      return accept({ status: 'ENDED', callId: state.callId });
    // Hang-up is idempotent; late transport noise and errors while closing are expected.
    case 'END_REQUESTED':
    case 'TRANSPORT_LOST':
    case 'GATEWAY_LOST':
    case 'FATAL_ERROR':
      return accept(state);
    // Late floor updates while hanging up are expected and meaningless.
    case 'FLOOR_CHANGED':
      return accept(state);
    case 'START_REQUESTED':
    case 'SESSION_CREATED':
    case 'MEDIA_CONNECTED':
    case 'GATEWAY_READY':
    case 'TRANSPORT_RECOVERED':
      return reject(state);
  }
}

export function reduceCall(state: CallState, event: CallEvent): Transition {
  switch (state.status) {
    case 'IDLE':
      return event.type === 'START_REQUESTED' ? accept({ status: 'PREPARING' }) : reject(state);
    case 'PREPARING':
      return fromPreparing(state, event);
    case 'CONNECTING':
    case 'RECONNECTING':
      return fromConnecting(state, event);
    case 'LISTENING':
    case 'USER_SPEAKING':
    case 'AGENT_WORKING':
    case 'AGENT_SPEAKING':
      return fromConnected(state, event);
    case 'ENDING':
      return fromEnding(state, event);
    case 'ENDED':
    case 'FAILED':
      // Terminal: never return to an active state (§12). A new call starts from a fresh IDLE.
      return event.type === 'END_REQUESTED' || event.type === 'CLEANUP_COMPLETE'
        ? accept(state)
        : reject(state);
  }
}
