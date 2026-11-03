import { describe, expect, it } from 'vitest';

import {
  INITIAL_CALL_STATE,
  isActive,
  isConnected,
  isTerminal,
  reduceCall,
  type CallError,
  type CallEvent,
  type CallEventType,
  type CallState,
  type CallStatus,
  type Floor,
} from './call-state';

const CALL = 'call_aaaaaaaaaaaaaaaaaaaa';
const ERROR: CallError = { code: 'NETWORK_LOST', message: 'Lost connection.', retryable: true };

const EVENTS: Record<CallEventType, CallEvent> = {
  START_REQUESTED: { type: 'START_REQUESTED' },
  SESSION_CREATED: { type: 'SESSION_CREATED', callId: CALL },
  MEDIA_CONNECTED: { type: 'MEDIA_CONNECTED' },
  GATEWAY_READY: { type: 'GATEWAY_READY' },
  GATEWAY_LOST: { type: 'GATEWAY_LOST' },
  TRANSPORT_LOST: { type: 'TRANSPORT_LOST' },
  TRANSPORT_RECOVERED: { type: 'TRANSPORT_RECOVERED' },
  FLOOR_CHANGED: { type: 'FLOOR_CHANGED', floor: { kind: 'agent_speaking', turnId: 'turn_1' } },
  END_REQUESTED: { type: 'END_REQUESTED' },
  FATAL_ERROR: { type: 'FATAL_ERROR', error: ERROR },
  CLEANUP_COMPLETE: { type: 'CLEANUP_COMPLETE' },
};

const STATES: Record<CallStatus, CallState> = {
  IDLE: { status: 'IDLE' },
  PREPARING: { status: 'PREPARING' },
  CONNECTING: { status: 'CONNECTING', callId: CALL, readiness: { media: false, gateway: false } },
  LISTENING: { status: 'LISTENING', callId: CALL },
  USER_SPEAKING: { status: 'USER_SPEAKING', callId: CALL },
  AGENT_WORKING: { status: 'AGENT_WORKING', callId: CALL, turnId: 'turn_1' },
  AGENT_SPEAKING: { status: 'AGENT_SPEAKING', callId: CALL, turnId: 'turn_1' },
  RECONNECTING: {
    status: 'RECONNECTING',
    callId: CALL,
    readiness: { media: false, gateway: true },
  },
  ENDING: { status: 'ENDING', callId: CALL },
  ENDED: { status: 'ENDED', callId: CALL },
  FAILED: { status: 'FAILED', callId: CALL, error: ERROR },
};

function run(events: CallEventType[], from: CallState = INITIAL_CALL_STATE): CallState {
  return events.reduce((state, type) => {
    const result = reduceCall(state, EVENTS[type]);
    expect(result.accepted, `${type} from ${state.status}`).toBe(true);
    return result.state;
  }, from);
}

/**
 * The full legality table: which status each event leads to from each status, or `null` when the
 * event is illegal there. Every (state, event) pair is listed, so a new state or event cannot slip
 * in untested.
 */
const TABLE: Record<CallStatus, Record<CallEventType, CallStatus | null>> = {
  IDLE: {
    START_REQUESTED: 'PREPARING',
    SESSION_CREATED: null,
    MEDIA_CONNECTED: null,
    GATEWAY_READY: null,
    GATEWAY_LOST: null,
    TRANSPORT_LOST: null,
    TRANSPORT_RECOVERED: null,
    FLOOR_CHANGED: null,
    END_REQUESTED: null,
    FATAL_ERROR: null,
    CLEANUP_COMPLETE: null,
  },
  PREPARING: {
    START_REQUESTED: null,
    SESSION_CREATED: 'CONNECTING',
    MEDIA_CONNECTED: null,
    GATEWAY_READY: null,
    GATEWAY_LOST: null,
    TRANSPORT_LOST: null,
    TRANSPORT_RECOVERED: null,
    FLOOR_CHANGED: null,
    END_REQUESTED: 'ENDING',
    FATAL_ERROR: 'FAILED',
    CLEANUP_COMPLETE: null,
  },
  CONNECTING: {
    START_REQUESTED: null,
    SESSION_CREATED: null,
    MEDIA_CONNECTED: 'CONNECTING',
    GATEWAY_READY: 'CONNECTING',
    GATEWAY_LOST: 'CONNECTING',
    TRANSPORT_LOST: 'RECONNECTING',
    TRANSPORT_RECOVERED: 'CONNECTING',
    FLOOR_CHANGED: null,
    END_REQUESTED: 'ENDING',
    FATAL_ERROR: 'FAILED',
    CLEANUP_COMPLETE: null,
  },
  LISTENING: {
    START_REQUESTED: null,
    SESSION_CREATED: null,
    MEDIA_CONNECTED: 'LISTENING',
    GATEWAY_READY: 'LISTENING',
    GATEWAY_LOST: 'RECONNECTING',
    TRANSPORT_LOST: 'RECONNECTING',
    TRANSPORT_RECOVERED: 'LISTENING',
    FLOOR_CHANGED: 'AGENT_SPEAKING',
    END_REQUESTED: 'ENDING',
    FATAL_ERROR: 'FAILED',
    CLEANUP_COMPLETE: null,
  },
  USER_SPEAKING: {
    START_REQUESTED: null,
    SESSION_CREATED: null,
    MEDIA_CONNECTED: 'USER_SPEAKING',
    GATEWAY_READY: 'USER_SPEAKING',
    GATEWAY_LOST: 'RECONNECTING',
    TRANSPORT_LOST: 'RECONNECTING',
    TRANSPORT_RECOVERED: 'USER_SPEAKING',
    FLOOR_CHANGED: 'AGENT_SPEAKING',
    END_REQUESTED: 'ENDING',
    FATAL_ERROR: 'FAILED',
    CLEANUP_COMPLETE: null,
  },
  AGENT_WORKING: {
    START_REQUESTED: null,
    SESSION_CREATED: null,
    MEDIA_CONNECTED: 'AGENT_WORKING',
    GATEWAY_READY: 'AGENT_WORKING',
    GATEWAY_LOST: 'RECONNECTING',
    TRANSPORT_LOST: 'RECONNECTING',
    TRANSPORT_RECOVERED: 'AGENT_WORKING',
    FLOOR_CHANGED: 'AGENT_SPEAKING',
    END_REQUESTED: 'ENDING',
    FATAL_ERROR: 'FAILED',
    CLEANUP_COMPLETE: null,
  },
  AGENT_SPEAKING: {
    START_REQUESTED: null,
    SESSION_CREATED: null,
    MEDIA_CONNECTED: 'AGENT_SPEAKING',
    GATEWAY_READY: 'AGENT_SPEAKING',
    GATEWAY_LOST: 'RECONNECTING',
    TRANSPORT_LOST: 'RECONNECTING',
    TRANSPORT_RECOVERED: 'AGENT_SPEAKING',
    FLOOR_CHANGED: 'AGENT_SPEAKING',
    END_REQUESTED: 'ENDING',
    FATAL_ERROR: 'FAILED',
    CLEANUP_COMPLETE: null,
  },
  RECONNECTING: {
    START_REQUESTED: null,
    SESSION_CREATED: null,
    MEDIA_CONNECTED: 'LISTENING',
    GATEWAY_READY: 'RECONNECTING',
    GATEWAY_LOST: 'RECONNECTING',
    TRANSPORT_LOST: 'RECONNECTING',
    TRANSPORT_RECOVERED: 'LISTENING',
    FLOOR_CHANGED: null,
    END_REQUESTED: 'ENDING',
    FATAL_ERROR: 'FAILED',
    CLEANUP_COMPLETE: null,
  },
  ENDING: {
    START_REQUESTED: null,
    SESSION_CREATED: null,
    MEDIA_CONNECTED: null,
    GATEWAY_READY: null,
    GATEWAY_LOST: 'ENDING',
    TRANSPORT_LOST: 'ENDING',
    TRANSPORT_RECOVERED: null,
    FLOOR_CHANGED: 'ENDING',
    END_REQUESTED: 'ENDING',
    FATAL_ERROR: 'ENDING',
    CLEANUP_COMPLETE: 'ENDED',
  },
  ENDED: {
    START_REQUESTED: null,
    SESSION_CREATED: null,
    MEDIA_CONNECTED: null,
    GATEWAY_READY: null,
    GATEWAY_LOST: null,
    TRANSPORT_LOST: null,
    TRANSPORT_RECOVERED: null,
    FLOOR_CHANGED: null,
    END_REQUESTED: 'ENDED',
    FATAL_ERROR: null,
    CLEANUP_COMPLETE: 'ENDED',
  },
  FAILED: {
    START_REQUESTED: null,
    SESSION_CREATED: null,
    MEDIA_CONNECTED: null,
    GATEWAY_READY: null,
    GATEWAY_LOST: null,
    TRANSPORT_LOST: null,
    TRANSPORT_RECOVERED: null,
    FLOOR_CHANGED: null,
    END_REQUESTED: 'FAILED',
    FATAL_ERROR: null,
    CLEANUP_COMPLETE: 'FAILED',
  },
};

describe('reduceCall legality table', () => {
  const cases = Object.entries(TABLE).flatMap(([status, row]) =>
    Object.entries(row).map(([type, expected]) => ({
      status: status as CallStatus,
      type: type as CallEventType,
      expected,
    })),
  );

  it.each(cases)('$status + $type → $expected', ({ status, type, expected }) => {
    const from = STATES[status];
    const result = reduceCall(from, EVENTS[type]);
    if (expected === null) {
      expect(result.accepted).toBe(false);
      expect(result.state).toBe(from);
    } else {
      expect(result.accepted).toBe(true);
      expect(result.state.status).toBe(expected);
    }
  });
});

describe('call sequences', () => {
  it('connects only after both media and gateway are ready, in either order', () => {
    const mediaFirst = run(['START_REQUESTED', 'SESSION_CREATED', 'MEDIA_CONNECTED']);
    expect(mediaFirst.status).toBe('CONNECTING');
    expect(run(['GATEWAY_READY'], mediaFirst)).toEqual({ status: 'LISTENING', callId: CALL });

    const gatewayFirst = run(['START_REQUESTED', 'SESSION_CREATED', 'GATEWAY_READY']);
    expect(gatewayFirst.status).toBe('CONNECTING');
    expect(run(['MEDIA_CONNECTED'], gatewayFirst).status).toBe('LISTENING');
  });

  it('a gateway that drops during connect must come back before the call connects', () => {
    const state = run([
      'START_REQUESTED',
      'SESSION_CREATED',
      'GATEWAY_READY',
      'GATEWAY_LOST',
      'MEDIA_CONNECTED',
    ]);
    expect(state.status).toBe('CONNECTING');
    expect(run(['GATEWAY_READY'], state).status).toBe('LISTENING');
  });

  it('recovers from a transport drop without a new call ID', () => {
    const state = run([
      'START_REQUESTED',
      'SESSION_CREATED',
      'MEDIA_CONNECTED',
      'GATEWAY_READY',
      'TRANSPORT_LOST',
    ]);
    expect(state).toEqual({
      status: 'RECONNECTING',
      callId: CALL,
      readiness: { media: false, gateway: true },
    });
    expect(run(['TRANSPORT_RECOVERED'], state)).toEqual({ status: 'LISTENING', callId: CALL });
  });

  it('waits for the gateway too when both halves dropped during reconnect', () => {
    const state = run(['TRANSPORT_LOST', 'GATEWAY_LOST', 'TRANSPORT_RECOVERED'], STATES.LISTENING);
    expect(state.status).toBe('RECONNECTING');
    expect(run(['GATEWAY_READY'], state).status).toBe('LISTENING');
  });

  it('a transport drop while connecting keeps gateway readiness', () => {
    const state = run(['START_REQUESTED', 'SESSION_CREATED', 'GATEWAY_READY', 'TRANSPORT_LOST']);
    expect(state).toEqual({
      status: 'RECONNECTING',
      callId: CALL,
      readiness: { media: false, gateway: true },
    });
  });

  it('mirrors a full conversational turn from the gateway floor', () => {
    const floors: Floor[] = [
      { kind: 'user_speaking' },
      { kind: 'agent_working', turnId: 'turn_1' },
      { kind: 'agent_working', turnId: 'turn_1', activity: 'Checking calendar…' },
      { kind: 'agent_speaking', turnId: 'turn_1' },
      { kind: 'listening' },
    ];
    const seen = floors.map(
      (floor) => reduceCall(STATES.LISTENING, { type: 'FLOOR_CHANGED', floor }).state,
    );
    expect(seen).toEqual([
      { status: 'USER_SPEAKING', callId: CALL },
      { status: 'AGENT_WORKING', callId: CALL, turnId: 'turn_1' },
      { status: 'AGENT_WORKING', callId: CALL, turnId: 'turn_1', activity: 'Checking calendar…' },
      { status: 'AGENT_SPEAKING', callId: CALL, turnId: 'turn_1' },
      { status: 'LISTENING', callId: CALL },
    ]);
  });

  it('a drop mid-answer reconnects and comes back listening, keeping the call ID', () => {
    const state = run(['TRANSPORT_LOST'], STATES.AGENT_SPEAKING);
    expect(state.status).toBe('RECONNECTING');
    expect(run(['TRANSPORT_RECOVERED'], state)).toEqual({ status: 'LISTENING', callId: CALL });
  });

  it('classifies connected states', () => {
    for (const status of ['LISTENING', 'USER_SPEAKING', 'AGENT_WORKING', 'AGENT_SPEAKING'] as const)
      expect(isConnected(STATES[status])).toBe(true);
    for (const status of ['CONNECTING', 'RECONNECTING', 'ENDING', 'FAILED'] as const)
      expect(isConnected(STATES[status])).toBe(false);
  });

  it('hang-up during any active state ends cleanly and keeps the call ID', () => {
    for (const status of [
      'CONNECTING',
      'LISTENING',
      'USER_SPEAKING',
      'AGENT_WORKING',
      'AGENT_SPEAKING',
      'RECONNECTING',
    ] as const) {
      expect(run(['END_REQUESTED', 'CLEANUP_COMPLETE'], STATES[status])).toEqual({
        status: 'ENDED',
        callId: CALL,
      });
    }
  });

  it('a fatal error carries its error and never returns to an active state', () => {
    const failed = run(['FATAL_ERROR'], STATES.LISTENING);
    expect(failed).toEqual({ status: 'FAILED', callId: CALL, error: ERROR });
    for (const event of Object.values(EVENTS)) {
      expect(isActive(reduceCall(failed, event).state)).toBe(false);
    }
  });

  it('classifies terminal and active states', () => {
    expect(isActive(STATES.IDLE)).toBe(false);
    expect(isActive(STATES.ENDING)).toBe(true);
    expect(isTerminal(STATES.ENDED)).toBe(true);
    expect(isTerminal(STATES.FAILED)).toBe(true);
    expect(isTerminal(STATES.LISTENING)).toBe(false);
  });
});
