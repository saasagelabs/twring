import { relayCallerIdentity } from '@twring/contracts';

import {
  CallAudioError,
  type CallAudio,
  type CallAudioIdentities,
  type CallAudioLifetimes,
  type CallAudioSession,
} from '../livekit/call-audio';

import { RelayAudioRefusedError, type RelayClient } from './relay-client';

/**
 * Twring-run call audio (`TWRING_AUDIO=twring`): the relay creates the room on Twring's LiveKit
 * project and hands back its address and two tokens limited to that room. The server never holds
 * Twring's LiveKit secret. A relay that cannot be reached fails the new call; calls in progress
 * are unaffected.
 */
export class RelayAudio implements CallAudio {
  constructor(
    private readonly relay: Pick<
      RelayClient,
      'audioSession' | 'endAudioSession' | 'endAudioSessionByCall'
    >,
  ) {}

  async start(
    callId: string,
    _identities: CallAudioIdentities,
    _lifetimes: CallAudioLifetimes,
  ): Promise<CallAudioSession> {
    let session;
    try {
      session = await this.relay.audioSession(callId);
    } catch (error) {
      if (error instanceof RelayAudioRefusedError) throw new CallAudioError(error.code);
      // The relay may have opened the session and only the answer was lost (a timeout): end it by
      // call id so its line is freed. Best effort; the relay also closes it from LiveKit.
      void this.relay.endAudioSessionByCall(callId).catch(() => undefined);
      throw new CallAudioError('audio_unavailable');
    }
    return {
      url: session.url,
      room: session.room,
      callerIdentity: relayCallerIdentity(callId),
      callerToken: session.caller_token,
      gatewayToken: session.server_token,
      expiresAt: new Date(session.expires_at),
    };
  }

  /** Tells the relay the call ended, so its minutes are counted and the room closed. */
  end(room: string): Promise<void> {
    return this.relay.endAudioSession(room);
  }

  /**
   * The server has no admin rights on Twring's rooms; the phone's and the server's tokens are
   * limited to the room and the room to two participants, so nothing is removed here.
   */
  removeParticipant(): Promise<void> {
    return Promise.resolve();
  }
}
