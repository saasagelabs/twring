import { dispose } from '@livekit/rtc-node';

import { CallRegistry, type CallRegistryOptions } from '../calls/registry';

import type { RoomService } from './rooms';
import { LiveKitRtcTransport } from './rtc-transport';
import { callAudioFor, type CallAudioSource } from './select-audio';

export type { CallAudioSource } from './select-audio';

export interface LiveKitCalls {
  registry: CallRegistry;
  /** The server's own LiveKit, for /health/ready; absent with Twring-run audio. */
  rooms?: RoomService;
}

/** Assembles the production call stack on LiveKit. Everything LiveKit-specific enters here. */
export function createLiveKitCalls(
  source: CallAudioSource,
  options: Pick<
    CallRegistryOptions,
    | 'env'
    | 'scheduler'
    | 'logger'
    | 'voice'
    | 'createAgent'
    | 'ttsForVoice'
    | 'sttForKeyterms'
    | 'speaksServerXai'
    | 'history'
    | 'onCallFinished'
  >,
): LiveKitCalls {
  const { audio, rooms } = callAudioFor(source);
  const registry = new CallRegistry({
    ...options,
    audio,
    transports: (params) => new LiveKitRtcTransport(params),
  });
  return { registry, ...(rooms && { rooms }) };
}

/** Releases the native WebRTC runtime. Call once, after every call has ended. */
export async function disposeLiveKit(): Promise<void> {
  await dispose();
}
