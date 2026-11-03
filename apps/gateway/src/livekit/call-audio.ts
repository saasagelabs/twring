import type { RoomService } from './rooms';

/** What a call needs from its audio: where to connect, the two join tokens, and the room. */
export interface CallAudioSession {
  url: string;
  room: string;
  /** The identity the phone joins as; any other participant is unexpected. */
  callerIdentity: string;
  callerToken: string;
  gatewayToken: string;
  /** When the phone's token expires, when the audio service says so. */
  expiresAt?: Date;
}

/** The room and caller identity the server would use itself; Twring-run audio picks its own. */
export interface CallAudioIdentities {
  room: string;
  callerIdentity: string;
}

/** How long each token lasts: the phone's to join, the server's for the whole call. */
export interface CallAudioLifetimes {
  callerTtlSeconds: number;
  gatewayTtlSeconds: number;
}

/**
 * A call's audio: the server's own LiveKit (hosted Twring and self-hosted `own`) or Twring's, through
 * the relay (self-hosted `twring`). Chosen once at start-up; a call never moves from one to the other.
 */
export interface CallAudio {
  start(
    callId: string,
    identities: CallAudioIdentities,
    lifetimes: CallAudioLifetimes,
  ): Promise<CallAudioSession>;
  /** Closes the room (disconnecting everyone). Resolves if it is already gone. */
  end(room: string): Promise<void>;
  /** Removes an unexpected participant, where this audio can. */
  removeParticipant(room: string, identity: string): Promise<void>;
}

export type CallAudioErrorCode =
  | 'audio_unavailable'
  | 'audio_unreachable'
  | 'audio_paused'
  | 'audio_expired'
  | 'audio_limit_reached';

/** How long the self-hosted check of the server's own LiveKit may take on a new call. */
export const OWN_AUDIO_CHECK_TIMEOUT_MS = 3_000;

/** Self-hosted call audio failed to start; `code` says whose audio, and the route says what to do. */
export class CallAudioError extends Error {
  constructor(readonly code: CallAudioErrorCode) {
    super(`call audio not started: ${code}`);
    this.name = 'CallAudioError';
  }
}

export interface CallTokenMinter {
  caller(request: { room: string; identity: string; ttlSeconds: number }): Promise<string>;
  gateway(request: { room: string; ttlSeconds: number }): Promise<string>;
}

export interface OwnLiveKitAudioOptions {
  url: string;
  rooms: RoomService;
  tokens: CallTokenMinter;
  /**
   * Self-hosted `own`: check the server's LiveKit answers before handing out tokens, and report a
   * failure as `audio_unreachable`. Hosted Twring leaves it off and behaves exactly as before.
   */
  selfhost?: boolean;
  /** Test seam: the limit on the self-hosted LiveKit check (default 3 s). */
  checkTimeoutMs?: number;
}

/** `promise`, or a rejection once `ms` pass. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('LiveKit check timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The server's own LiveKit: tokens minted here, the room created by the first join from the
 * settings in the tokens (see tokens.ts). Room names and token claims are those of `ids.ts` and
 * `tokens.ts`, unchanged.
 */
export class OwnLiveKitAudio implements CallAudio {
  constructor(private readonly options: OwnLiveKitAudioOptions) {}

  async start(
    _callId: string,
    identities: CallAudioIdentities,
    lifetimes: CallAudioLifetimes,
  ): Promise<CallAudioSession> {
    const { url, rooms, tokens, selfhost } = this.options;
    try {
      const [callerToken, gatewayToken] = await Promise.all([
        tokens.caller({
          room: identities.room,
          identity: identities.callerIdentity,
          ttlSeconds: lifetimes.callerTtlSeconds,
        }),
        tokens.gateway({ room: identities.room, ttlSeconds: lifetimes.gatewayTtlSeconds }),
        ...(selfhost === true
          ? [within(rooms.ping(), this.options.checkTimeoutMs ?? OWN_AUDIO_CHECK_TIMEOUT_MS)]
          : []),
      ]);
      return {
        url,
        room: identities.room,
        callerIdentity: identities.callerIdentity,
        callerToken,
        gatewayToken,
      };
    } catch (error) {
      void rooms.deleteRoom(identities.room).catch(() => undefined);
      // Never a switch to Twring's audio: the call fails and says how to check the server.
      if (selfhost === true) throw new CallAudioError('audio_unreachable');
      throw error;
    }
  }

  end(room: string): Promise<void> {
    return this.options.rooms.deleteRoom(room);
  }

  removeParticipant(room: string, identity: string): Promise<void> {
    return this.options.rooms.removeParticipant(room, identity);
  }
}
