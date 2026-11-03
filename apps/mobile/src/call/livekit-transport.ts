import {
  GATEWAY_END_REASON_ATTRIBUTE,
  GATEWAY_IDENTITY,
  GATEWAY_STATE_ATTRIBUTE,
  MAX_STATUS_MESSAGE_BYTES,
  STATUS_TOPIC,
  gatewayEndReasonSchema,
  parseStatusMessage,
} from '@twring/contracts';
import { AndroidAudioTypePresets, AudioSession } from '@livekit/react-native';
import {
  DisconnectReason,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
} from 'livekit-client';

import { downlinkWindow, type ReceiverSample } from './downlink';
import { LEVEL_INTERVAL_MS } from './levels';
import {
  MicrophoneError,
  type CallTransport,
  type ConnectParams,
  type TransportEvent,
} from './transport';

/** Status packets are UTF-8 JSON (captions can hold any language); oversized ones are dropped. */
const utf8 = new TextDecoder('utf-8');
function decodeStatus(payload: Uint8Array): string | undefined {
  if (payload.byteLength > MAX_STATUS_MESSAGE_BYTES) return undefined;
  try {
    return utf8.decode(payload);
  } catch {
    return undefined;
  }
}

const SERVER_ENDED: ReadonlySet<DisconnectReason | undefined> = new Set([
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.SERVER_SHUTDOWN,
]);

function disconnectCause(
  reason: DisconnectReason | undefined,
): 'client' | 'server_ended' | 'network' {
  if (reason === DisconnectReason.CLIENT_INITIATED) return 'client';
  return SERVER_ENDED.has(reason) ? 'server_ended' : 'network';
}

function isPermissionError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError';
}

/** Downlink quality sampling period: coarse enough to be cheap, fine enough to spot dropouts. */
const DOWNLINK_STATS_INTERVAL_MS = 5000;

const isGateway = (participant: Participant | undefined) =>
  participant?.identity === GATEWAY_IDENTITY;
const gatewayIsReady = (participant: Participant) =>
  participant.attributes[GATEWAY_STATE_ATTRIBUTE] === 'ready';
/** The gateway's stated reason for leaving, once it is `ending`; unknown values are ignored. */
const gatewayEndReason = (participant: Participant) => {
  if (participant.attributes[GATEWAY_STATE_ATTRIBUTE] !== 'ending') return undefined;
  const parsed = gatewayEndReasonSchema.safeParse(
    participant.attributes[GATEWAY_END_REASON_ATTRIBUTE],
  );
  return parsed.success ? parsed.data : undefined;
};

/**
 * CallTransport over LiveKit. The only file in the app that touches livekit-client or the native
 * audio session. Only the Twring gateway participant is trusted as a source of call status.
 */
export class LiveKitCallTransport implements CallTransport {
  private readonly room = new Room({
    adaptiveStream: false,
    dynacast: false,
    // Echo cancellation stays on (Twring's voice must not reach STT). Noise suppression and auto gain
    // are off: on a moto g86 they muffled speech (1-4 kHz 8-12 dB lower, 418 clipped samples) and
    // Deepgram mis-heard 3 of 5 test sentences; without them 4 of 5 were exact. Re-check noisy
    // rooms in the Milestone 8 device matrix.
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  private audioSessionStarted = false;
  private disconnecting: Promise<void> | undefined;
  private downlinkTimer: ReturnType<typeof setInterval> | undefined;
  private levelTimer: ReturnType<typeof setInterval> | undefined;

  async connect(
    params: ConnectParams,
    onEvent: (event: TransportEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let gatewayReady = false;
    let endReported = false;
    const reportGateway = (participant: Participant) => {
      const endReason = gatewayEndReason(participant);
      if (endReason !== undefined && !endReported) {
        endReported = true;
        onEvent({ type: 'gateway_ending', reason: endReason });
      }
      const ready = gatewayIsReady(participant);
      if (ready && !gatewayReady) onEvent({ type: 'gateway_ready' });
      if (!ready && gatewayReady) onEvent({ type: 'gateway_lost' });
      gatewayReady = ready;
    };

    this.room
      // A signal-only drop emits SignalReconnecting (then Reconnected on resume); Reconnecting
      // fires only when media must be rebuilt too. Both mean the call is not live right now.
      .on(RoomEvent.SignalReconnecting, () => onEvent({ type: 'reconnecting' }))
      .on(RoomEvent.Reconnecting, () => onEvent({ type: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => onEvent({ type: 'reconnected' }))
      .on(RoomEvent.Disconnected, (reason) =>
        onEvent({ type: 'disconnected', cause: disconnectCause(reason) }),
      )
      // Only the Twring gateway's audio is played. Anything else in the room (for example an agent a
      // LiveKit project dispatches automatically) is never subscribed, so it is neither heard nor
      // sent our microphone by the SFU on our behalf.
      .on(RoomEvent.TrackPublished, (publication, participant) => {
        if (isGateway(participant) && publication.kind === Track.Kind.Audio) {
          publication.setSubscribed(true);
        }
      })
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        if (isGateway(participant)) reportGateway(participant);
      })
      .on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
        if (isGateway(participant)) reportGateway(participant);
      })
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        if (isGateway(participant) && gatewayReady) {
          gatewayReady = false;
          onEvent({ type: 'gateway_lost' });
        }
      })
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (topic !== STATUS_TOPIC || !isGateway(participant)) return;
        const text = decodeStatus(payload);
        const message = text === undefined ? undefined : parseStatusMessage(text);
        if (message !== undefined) onEvent({ type: 'status', message });
      });

    const abort = () => void this.disconnect();
    if (signal.aborted) throw new Error('connect aborted');
    signal.addEventListener('abort', abort);
    try {
      // Speaker unless a headset is connected; Bluetooth and wired take over when they appear.
      // iOS keeps LiveKit's default playAndRecord/voiceChat session (ADR-019).
      await AudioSession.configureAudio({
        android: {
          preferredOutputList: ['bluetooth', 'headset', 'speaker', 'earpiece'],
          audioTypeOptions: AndroidAudioTypePresets.communication,
        },
        ios: { defaultOutput: 'speaker' },
      });
      await AudioSession.startAudioSession();
      this.audioSessionStarted = true;
      // An abort while the session was starting ran disconnect() before there was a session to stop.
      if (signal.aborted) {
        await this.stopAudioSession();
        throw new Error('connect aborted');
      }
      await this.room.connect(params.url, params.token, { autoSubscribe: false });
      if (signal.aborted) throw new Error('connect aborted');

      // participantConnected does not fire for a gateway that joined first.
      const gateway = this.room.remoteParticipants.get(GATEWAY_IDENTITY);
      if (gateway !== undefined) {
        reportGateway(gateway);
        for (const publication of gateway.audioTrackPublications.values()) {
          publication.setSubscribed(true);
        }
      }

      try {
        await this.room.localParticipant.setMicrophoneEnabled(true);
      } catch (error) {
        throw new MicrophoneError(isPermissionError(error) ? 'denied' : 'unavailable');
      }
      if (signal.aborted) throw new Error('connect aborted');
      this.startDownlinkStats(onEvent);
      this.startLevels(onEvent);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  /** Samples what the phone actually receives and plays from the gateway track. */
  private startDownlinkStats(onEvent: (event: TransportEvent) => void): void {
    let previous: ReceiverSample | undefined;
    this.downlinkTimer = setInterval(() => {
      const publication = this.room.remoteParticipants
        .get(GATEWAY_IDENTITY)
        ?.audioTrackPublications.values()
        .next().value;
      const track = publication?.track;
      if (!(track instanceof RemoteAudioTrack)) return;
      void track
        .getReceiverStats()
        .then((stats) => {
          if (stats === undefined) return;
          const sample: ReceiverSample = { ...stats, at: Date.now() };
          if (previous !== undefined) {
            onEvent({ type: 'downlink_stats', window: downlinkWindow(previous, sample) });
          }
          previous = sample;
        })
        .catch(() => undefined);
    }, DOWNLINK_STATS_INTERVAL_MS);
  }

  /**
   * Reports the levels LiveKit measured for this phone's microphone and the gateway's voice
   * (participant audioLevel, updated with the SFU's speaker reports). Sampled at a fixed ~12 Hz and
   * sent only when a level changed, so a quiet call costs nothing downstream.
   */
  private startLevels(onEvent: (event: TransportEvent) => void): void {
    let local = 0;
    let remote = 0;
    this.levelTimer = setInterval(() => {
      const nextLocal = this.room.localParticipant.audioLevel;
      const nextRemote = this.room.remoteParticipants.get(GATEWAY_IDENTITY)?.audioLevel ?? 0;
      if (nextLocal === local && nextRemote === remote) return;
      local = nextLocal;
      remote = nextRemote;
      onEvent({ type: 'levels', levels: { local, remote } });
    }, LEVEL_INTERVAL_MS);
  }

  async setMicrophoneMuted(muted: boolean): Promise<void> {
    // Mutes the published track in place (no unpublish), so unmuting is instant.
    await this.room.localParticipant.setMicrophoneEnabled(!muted);
  }

  async restartMicrophone(): Promise<void> {
    // Sending nothing for a moment stops the phone's recorder (it is the only audio sent), and
    // sending again starts a fresh one, on the same published track the gateway keeps reading.
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (track === undefined) return;
    try {
      await track.pauseUpstream();
    } finally {
      await track.resumeUpstream();
    }
  }

  disconnect(): Promise<void> {
    clearInterval(this.downlinkTimer);
    clearInterval(this.levelTimer);
    this.disconnecting ??= (async () => {
      try {
        await this.room.disconnect();
      } finally {
        await this.stopAudioSession();
      }
    })();
    return this.disconnecting;
  }

  /** Stops the audio session once, whichever of connect's abort path or disconnect gets there first. */
  private async stopAudioSession(): Promise<void> {
    if (!this.audioSessionStarted) return;
    this.audioSessionStarted = false;
    await AudioSession.stopAudioSession();
  }
}
