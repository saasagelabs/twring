/**
 * Named call-lifecycle timeouts (CALL_STATE_MACHINE §10). Tunable values that operators may need
 * live in GatewayEnv; these are protocol-level budgets that change only with code review.
 */
export const CALL_TIMEOUTS = {
  /** The caller has this long after the call is created to join the room. */
  callerJoinMs: 30_000,
  /** After the caller leaves, wait this long for a rejoin before ending the call. */
  callerRejoinGraceMs: 20_000,
  /** Gateway's own LiveKit connect attempt. */
  gatewayConnectMs: 10_000,
  /** Connecting to the call's agent, alongside the speech providers. */
  agentConnectMs: 10_000,
  /**
   * A call that fails before the caller joins (agent or voice unavailable) keeps the gateway in the
   * room with the end reason set this long, or until the caller joins, so the phone can read it.
   */
  failureNoticeMs: 8000,
  /** How often audio_stats goes to the caller. */
  audioStatsIntervalMs: 1000,
} as const;

/** Echo delay for the Milestone 1 audio test, long enough to tell apart from sidetone. */
export const ECHO_DELAY_MS = 600;

/** LiveKit room settings: close rooms nobody is using even if the gateway is gone. */
export const ROOM_SETTINGS = {
  emptyTimeoutS: 60,
  departureTimeoutS: 20,
  maxParticipants: 2,
} as const;
