import type { GatewayEndReason, GatewayState, StatusMessage } from '@twring/contracts';

/**
 * What the call runtime needs from realtime media. The LiveKit implementation lives in
 * src/livekit; provider SDK objects never cross this interface (ARCHITECTURE §13).
 */
export type TransportEvent =
  /** The caller's participant is in the room (first join or rejoin). */
  | { type: 'caller_joined' }
  | { type: 'caller_left' }
  /** The caller muted or unmuted their microphone: while muted, no audio arriving is expected. */
  | { type: 'caller_muted' }
  | { type: 'caller_unmuted' }
  /** The caller subscribed to the gateway's audio track, so it can hear what we publish. */
  | { type: 'caller_listening' }
  /** The gateway's own connection is recovering / recovered. */
  | { type: 'reconnecting' }
  | { type: 'reconnected' }
  /** Someone other than the caller joined the call room (e.g. an auto-dispatched agent). */
  | { type: 'unexpected_participant'; identity: string }
  /** The gateway left the room for good (room deleted, kicked, or unrecoverable). */
  | { type: 'disconnected'; reason: string };

export interface TransportHandlers {
  onEvent(event: TransportEvent): void;
  /** One 20 ms mono 48 kHz frame of caller microphone audio. */
  onCallerFrame(samples: Int16Array): void;
}

export interface MediaTransport {
  /** Joins the room and publishes the gateway's audio track. Rejects if it cannot. */
  connect(handlers: TransportHandlers, signal: AbortSignal): Promise<void>;
  /** Queues one 20 ms frame on the gateway's audio track; resolves when the queue has room. */
  publishFrame(samples: Int16Array): Promise<void>;
  /** Drops audio queued but not yet sent (the future barge-in path). */
  clearOutput(): void;
  /** `endReason` accompanies `ending` so the phone can say why the call ended. */
  setGatewayState(state: GatewayState, endReason?: GatewayEndReason): Promise<void>;
  /** Lossy by default (fine for periodic stats); `reliable` for captions and speech state. */
  sendStatus(message: StatusMessage, options?: { reliable?: boolean }): Promise<void>;
  /** Leaves the room. Idempotent. */
  close(): Promise<void>;
}

export interface TransportParams {
  url: string;
  token: string;
  callerIdentity: string;
}

export type MediaTransportFactory = (params: TransportParams) => MediaTransport;
