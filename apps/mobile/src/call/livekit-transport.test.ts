import { GATEWAY_IDENTITY } from '@twring/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LEVEL_INTERVAL_MS } from './levels';
import type { TransportEvent } from './transport';

// Milestone 9 verifier: the level poller's lifecycle, against a stand-in LiveKit room.
const rooms = vi.hoisted(() => [] as FakeRoomShape[]);

interface FakeMicTrack {
  pauseUpstream: () => Promise<void>;
  resumeUpstream: () => Promise<void>;
}

interface FakeRoomShape {
  localParticipant: {
    audioLevel: number;
    setMicrophoneEnabled: (on: boolean) => Promise<void>;
    microphone: { track?: FakeMicTrack } | undefined;
    getTrackPublication: (source: string) => { track?: FakeMicTrack } | undefined;
  };
  remoteParticipants: Map<string, { audioLevel: number }>;
  connectGate: Promise<void>;
  disconnects: number;
}

const audio = vi.hoisted(() => ({
  started: 0,
  stopped: 0,
  startGate: Promise.resolve(),
}));

vi.mock('@livekit/react-native', () => ({
  AndroidAudioTypePresets: { communication: {} },
  AudioSession: {
    configureAudio: () => Promise.resolve(),
    startAudioSession: async () => {
      await audio.startGate;
      audio.started += 1;
    },
    stopAudioSession: () => {
      audio.stopped += 1;
      return Promise.resolve();
    },
  },
}));

vi.mock('livekit-client', () => {
  class Room implements FakeRoomShape {
    localParticipant: FakeRoomShape['localParticipant'] = {
      audioLevel: 0,
      setMicrophoneEnabled: () => Promise.resolve(),
      microphone: undefined,
      getTrackPublication: (source: string) =>
        source === 'microphone' ? this.localParticipant.microphone : undefined,
    };
    remoteParticipants = new Map<string, { audioLevel: number }>();
    connectGate = Promise.resolve();
    disconnects = 0;
    constructor() {
      rooms.push(this);
    }
    on() {
      return this;
    }
    connect() {
      return this.connectGate;
    }
    disconnect() {
      this.disconnects += 1;
      return Promise.resolve();
    }
  }
  return {
    Room,
    RoomEvent: {},
    Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
    RemoteAudioTrack: class {},
    DisconnectReason: {
      CLIENT_INITIATED: 1,
      ROOM_DELETED: 2,
      PARTICIPANT_REMOVED: 3,
      SERVER_SHUTDOWN: 4,
    },
  };
});

const { LiveKitCallTransport } = await import('./livekit-transport');

beforeEach(() => {
  vi.useFakeTimers();
  rooms.length = 0;
  audio.started = 0;
  audio.stopped = 0;
  audio.startGate = Promise.resolve();
});
afterEach(() => {
  vi.useRealTimers();
});

const PARAMS = { url: 'wss://lk.test', token: 't' };

function levelsOf(events: TransportEvent[]) {
  return events.flatMap((event) => (event.type === 'levels' ? [event.levels] : []));
}

describe('LiveKitCallTransport levels', () => {
  it('polls every interval, reports only changes, and stops for good on disconnect', async () => {
    const transport = new LiveKitCallTransport();
    const events: TransportEvent[] = [];
    await transport.connect(PARAMS, (event) => events.push(event), new AbortController().signal);
    const room = rooms[0];
    const gateway = { audioLevel: 0 };
    room.remoteParticipants.set(GATEWAY_IDENTITY, gateway);

    vi.advanceTimersByTime(LEVEL_INTERVAL_MS * 3);
    expect(levelsOf(events)).toEqual([]); // silence is not re-sent
    room.localParticipant.audioLevel = 0.4;
    gateway.audioLevel = 0.2;
    vi.advanceTimersByTime(LEVEL_INTERVAL_MS);
    expect(levelsOf(events)).toEqual([{ local: 0.4, remote: 0.2 }]);
    vi.advanceTimersByTime(LEVEL_INTERVAL_MS * 5);
    expect(levelsOf(events)).toHaveLength(1);

    await transport.disconnect();
    room.localParticipant.audioLevel = 0.9;
    vi.advanceTimersByTime(LEVEL_INTERVAL_MS * 10);
    expect(levelsOf(events)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    // Idempotent.
    await transport.disconnect();
    expect(room.disconnects).toBe(1);
  });

  it('reads a missing gateway as silence', async () => {
    const transport = new LiveKitCallTransport();
    const events: TransportEvent[] = [];
    await transport.connect(PARAMS, (event) => events.push(event), new AbortController().signal);
    rooms[0].localParticipant.audioLevel = 0.5;
    vi.advanceTimersByTime(LEVEL_INTERVAL_MS);
    expect(levelsOf(events)).toEqual([{ local: 0.5, remote: 0 }]);
    await transport.disconnect();
  });

  it('never starts polling when the connect is aborted part-way', async () => {
    const transport = new LiveKitCallTransport();
    const events: TransportEvent[] = [];
    const controller = new AbortController();
    let open!: () => void;
    const pending = (async () => {
      await Promise.resolve();
      rooms[0].connectGate = new Promise<void>((resolve) => (open = resolve));
    })();
    const connecting = transport.connect(PARAMS, (event) => events.push(event), controller.signal);
    await pending;
    controller.abort();
    open?.();
    await expect(connecting).rejects.toThrow(/aborted/);
    vi.advanceTimersByTime(LEVEL_INTERVAL_MS * 10);
    expect(vi.getTimerCount()).toBe(0);
    expect(levelsOf(events)).toEqual([]);
  });
});

describe('LiveKitCallTransport audio session', () => {
  it('stops an audio session that finished starting after the connect was aborted', async () => {
    let start!: () => void;
    audio.startGate = new Promise<void>((resolve) => (start = resolve));
    const transport = new LiveKitCallTransport();
    const controller = new AbortController();
    const connecting = transport.connect(PARAMS, () => undefined, controller.signal);
    await Promise.resolve();
    controller.abort(); // disconnect() runs now, before the session has started
    await transport.disconnect();
    start();
    await expect(connecting).rejects.toThrow(/aborted/);
    expect(audio.started).toBe(1);
    expect(audio.stopped).toBe(1);
  });

  it('stops the audio session exactly once on a normal hang-up', async () => {
    const transport = new LiveKitCallTransport();
    await transport.connect(PARAMS, () => undefined, new AbortController().signal);
    await Promise.all([transport.disconnect(), transport.disconnect()]);
    expect(audio.stopped).toBe(1);
  });
});

describe('LiveKitCallTransport microphone restart', () => {
  async function connected() {
    const transport = new LiveKitCallTransport();
    await transport.connect(PARAMS, () => undefined, new AbortController().signal);
    return { transport, room: rooms[0] };
  }

  it('stops sending the microphone and sends it again, so recording starts afresh', async () => {
    const { transport, room } = await connected();
    const calls: string[] = [];
    room.localParticipant.microphone = {
      track: {
        pauseUpstream: () => {
          calls.push('pause');
          return Promise.resolve();
        },
        resumeUpstream: () => {
          calls.push('resume');
          return Promise.resolve();
        },
      },
    };
    await transport.restartMicrophone();
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('sends the microphone again even when stopping it failed', async () => {
    const { transport, room } = await connected();
    const calls: string[] = [];
    room.localParticipant.microphone = {
      track: {
        pauseUpstream: () => Promise.reject(new Error('busy')),
        resumeUpstream: () => {
          calls.push('resume');
          return Promise.resolve();
        },
      },
    };
    await expect(transport.restartMicrophone()).rejects.toThrow('busy');
    expect(calls).toEqual(['resume']);
  });

  it('does nothing before the microphone is published', async () => {
    const { transport } = await connected();
    await expect(transport.restartMicrophone()).resolves.toBeUndefined();
  });
});
