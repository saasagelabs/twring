import {
  GATEWAY_END_REASON_ATTRIBUTE,
  GATEWAY_STATE_ATTRIBUTE,
  STATUS_TOPIC,
  type GatewayEndReason,
  type GatewayState,
} from '@twring/contracts';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  DisconnectReason,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
} from '@livekit/rtc-node';

import { FRAME_MS, SAMPLE_RATE, SAMPLES_PER_FRAME } from '../audio/pcm';
import type { MediaTransport, TransportHandlers, TransportParams } from '../calls/transport';

/** How much gateway audio LiveKit may buffer ahead of playout. Small keeps barge-in snappy later. */
const OUTPUT_QUEUE_MS = 200;

/**
 * MediaTransport over a LiveKit room via the Rust-backed Node SDK. All `@livekit/rtc-node` types
 * stay inside this file.
 */
export class LiveKitRtcTransport implements MediaTransport {
  private readonly room = new Room();
  private readonly source = new AudioSource(SAMPLE_RATE, 1, OUTPUT_QUEUE_MS);
  private readonly encoder = new TextEncoder();
  private handlers: TransportHandlers | undefined;
  private readingTrackSid: string | undefined;
  private closed = false;

  constructor(private readonly params: TransportParams) {}

  async connect(handlers: TransportHandlers, signal: AbortSignal): Promise<void> {
    this.handlers = handlers;
    this.subscribeRoomEvents();

    // The signal only bounds connecting. Its listener is removed once connected, so a later
    // abort (e.g. the connect timeout firing mid-call) cannot tear down a live call.
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(new Error('gateway connect aborted'));
        void this.close();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([
        this.room.connect(this.params.url, this.params.token, {
          // Subscribe explicitly to the caller's microphone only (see subscribeRoomEvents).
          autoSubscribe: false,
          dynacast: false,
        }),
        aborted,
      ]);
      const track = LocalAudioTrack.createAudioTrack('cord-gateway-audio', this.source);
      await Promise.race([
        this.room.localParticipant!.publishTrack(
          track,
          new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
        ),
        aborted,
      ]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }

    // participantConnected does not fire for someone already in the room.
    for (const participant of this.room.remoteParticipants.values()) {
      if (participant.identity !== this.params.callerIdentity) {
        handlers.onEvent({ type: 'unexpected_participant', identity: participant.identity });
        continue;
      }
      handlers.onEvent({ type: 'caller_joined' });
      for (const publication of participant.trackPublications.values()) {
        if (publication.kind === TrackKind.KIND_AUDIO) publication.setSubscribed(true);
        if (publication.track !== undefined)
          this.maybeReadCallerAudio(publication.track, participant);
      }
    }
  }

  async publishFrame(samples: Int16Array): Promise<void> {
    if (this.closed) return;
    await this.source.captureFrame(new AudioFrame(samples, SAMPLE_RATE, 1, SAMPLES_PER_FRAME));
  }

  clearOutput(): void {
    this.source.clearQueue();
  }

  async setGatewayState(state: GatewayState, endReason?: GatewayEndReason): Promise<void> {
    if (this.closed || this.room.localParticipant === undefined) return;
    // One update, so the phone never sees `ending` without its reason.
    await this.room.localParticipant.setAttributes({
      [GATEWAY_STATE_ATTRIBUTE]: state,
      ...(endReason !== undefined && { [GATEWAY_END_REASON_ATTRIBUTE]: endReason }),
    });
  }

  async sendStatus(
    message: Parameters<MediaTransport['sendStatus']>[0],
    options: { reliable?: boolean } = {},
  ): Promise<void> {
    if (this.closed || this.room.localParticipant === undefined) return;
    await this.room.localParticipant.publishData(this.encoder.encode(JSON.stringify(message)), {
      reliable: options.reliable ?? false,
      topic: STATUS_TOPIC,
      destination_identities: [this.params.callerIdentity],
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.room.removeAllListeners();
    try {
      await this.room.disconnect();
    } finally {
      await this.source.close();
    }
  }

  private subscribeRoomEvents(): void {
    const { callerIdentity } = this.params;
    const emit: TransportHandlers['onEvent'] = (event) => {
      if (!this.closed) this.handlers?.onEvent(event);
    };

    this.room
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        if (participant.identity === callerIdentity) emit({ type: 'caller_joined' });
        else emit({ type: 'unexpected_participant', identity: participant.identity });
      })
      .on(RoomEvent.TrackPublished, (publication, participant: RemoteParticipant) => {
        if (participant.identity === callerIdentity && publication.kind === TrackKind.KIND_AUDIO) {
          publication.setSubscribed(true);
        }
      })
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        if (participant.identity !== callerIdentity) return;
        this.readingTrackSid = undefined;
        emit({ type: 'caller_left' });
      })
      .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        this.maybeReadCallerAudio(track, participant);
      })
      .on(RoomEvent.TrackMuted, (_publication, participant) => {
        if (participant.identity === callerIdentity) emit({ type: 'caller_muted' });
      })
      .on(RoomEvent.TrackUnmuted, (_publication, participant) => {
        if (participant.identity === callerIdentity) emit({ type: 'caller_unmuted' });
      })
      .on(RoomEvent.LocalTrackSubscribed, () => emit({ type: 'caller_listening' }))
      .on(RoomEvent.Reconnecting, () => emit({ type: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => emit({ type: 'reconnected' }))
      .on(RoomEvent.Disconnected, (reason) => {
        emit({ type: 'disconnected', reason: DisconnectReason[reason] ?? 'UNKNOWN' });
      });
  }

  private maybeReadCallerAudio(track: RemoteTrack, participant: RemoteParticipant): void {
    if (participant.identity !== this.params.callerIdentity) return;
    if (track.kind !== TrackKind.KIND_AUDIO || track.sid === undefined) return;
    if (this.readingTrackSid === track.sid) return;
    this.readingTrackSid = track.sid;
    void this.readCallerAudio(track, track.sid);
  }

  /** Pumps the caller's microphone into the runtime until the track changes or the call closes. */
  private async readCallerAudio(track: RemoteTrack, sid: string): Promise<void> {
    const stream = new AudioStream(track, {
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      frameSizeMs: FRAME_MS,
    });
    try {
      for await (const frame of stream) {
        if (this.closed || this.readingTrackSid !== sid) break;
        this.handlers?.onCallerFrame(frame.data);
      }
    } catch {
      // The stream ends with an error when the track is unpublished; the room events report why.
    } finally {
      await stream.cancel().catch(() => undefined);
    }
  }
}
