import type { GatewayEndReason, StatusMessage } from '@twring/contracts';

import type { DownlinkWindow } from './downlink';
import type { AudioLevels } from './levels';

/**
 * What the call controller needs from realtime media. The LiveKit implementation lives in
 * livekit-transport.ts; nothing here imports React Native, so the controller stays unit-testable.
 */
export type TransportEvent =
  | { type: 'reconnecting' }
  | { type: 'reconnected' }
  /** The room is gone. `server_ended` = the gateway hung up or deleted the room. */
  | { type: 'disconnected'; cause: 'client' | 'server_ended' | 'network' }
  | { type: 'gateway_ready' }
  | { type: 'gateway_lost' }
  /** The gateway is leaving and said why (it sets this just before it goes). */
  | { type: 'gateway_ending'; reason: GatewayEndReason }
  /** A validated status packet from the Twring gateway participant. */
  | { type: 'status'; message: StatusMessage }
  /** What the phone received and played from the gateway over the last window. */
  | { type: 'downlink_stats'; window: DownlinkWindow }
  /** Current microphone and gateway-voice levels (0…1), sampled at most ~12 times a second. */
  | { type: 'levels'; levels: AudioLevels };

export interface ConnectParams {
  url: string;
  token: string;
}

/** Thrown by connect() when the microphone cannot be used. */
export class MicrophoneError extends Error {
  constructor(readonly reason: 'denied' | 'unavailable') {
    super(`microphone ${reason}`);
    this.name = 'MicrophoneError';
  }
}

export interface CallTransport {
  /**
   * Joins the room and publishes the microphone. Resolves once media is flowing both ways;
   * rejects (MicrophoneError for mic problems) on failure or when `signal` aborts.
   */
  connect(
    params: ConnectParams,
    onEvent: (event: TransportEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Mutes or unmutes the published microphone. The gateway then simply receives silence. */
  setMicrophoneMuted(muted: boolean): Promise<void>;
  /** Re-acquires the microphone in place: the published track stays, its capture starts again. */
  restartMicrophone(): Promise<void>;
  /** Leaves the room and releases the audio session. Idempotent. */
  disconnect(): Promise<void>;
}

/**
 * Keeps a connected call alive with the screen off or the app in the background (ADR-019).
 * Android: a microphone foreground service with an ongoing notification. iOS: no-op (the `audio`
 * background mode does the work).
 */
export interface CallBackgroundService {
  /** Before connecting: asks for what the ongoing notification needs. Never rejects. */
  prepare(): Promise<void>;
  /** The call connected. May reject (for example Android refusing a start from the background). */
  start(info: { agentName: string }): Promise<void>;
  /** Idempotent; safe when start() never ran or failed. */
  stop(): Promise<void>;
  /** Keeps the call screen awake, with proximity blanking and lock-screen display on Android. */
  setCallScreen(active: boolean): void;
}

export type MicrophonePermission = 'granted' | 'denied' | 'blocked' | 'undetermined';

/** Platform seam (MOBILE_PLATFORM_SPEC §3). */
export interface MicrophonePermissionService {
  /** Asks the OS if needed. `undetermined` = this platform prompts on first capture instead. */
  request(): Promise<MicrophonePermission>;
}
