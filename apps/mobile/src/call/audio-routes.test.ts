import { describe, expect, it } from 'vitest';

import {
  AudioRoutes,
  iosAudioConfiguration,
  nextRoute,
  parseOutputs,
  type AudioOutput,
} from './audio-routes';

describe('route policy', () => {
  it('maps the iOS choices to LiveKit ids', () => {
    expect(parseOutputs(['default', 'force_speaker'])).toEqual(['speaker', 'earpiece']);
    expect(iosAudioConfiguration('speaker')).toEqual({
      audioCategory: 'playAndRecord',
      audioCategoryOptions: [
        'allowBluetooth',
        'allowBluetoothA2DP',
        'allowAirPlay',
        'defaultToSpeaker',
      ],
      audioMode: 'videoChat',
    });
    const phone = iosAudioConfiguration('earpiece');
    expect(phone.audioMode).toBe('voiceChat');
    expect(phone.audioCategoryOptions).not.toContain('defaultToSpeaker');
  });
  it('orders known outputs by preference and drops unknown ones', () => {
    expect(parseOutputs(['earpiece', 'speaker', 'usb', 'bluetooth'])).toEqual([
      'bluetooth',
      'speaker',
      'earpiece',
    ]);
  });

  it('defaults to speaker when no headset is connected', () => {
    expect(nextRoute([], ['speaker', 'earpiece'], undefined)).toBe('speaker');
  });

  it('switches to a newly connected Bluetooth or wired headset, even over a manual choice', () => {
    expect(
      nextRoute(['speaker', 'earpiece'], ['bluetooth', 'speaker', 'earpiece'], 'earpiece'),
    ).toBe('bluetooth');
    expect(nextRoute(['speaker', 'earpiece'], ['headset', 'speaker', 'earpiece'], 'speaker')).toBe(
      'headset',
    );
  });

  it('keeps a manual choice while nothing new arrives', () => {
    const outputs: AudioOutput[] = ['bluetooth', 'speaker', 'earpiece'];
    expect(nextRoute(outputs, outputs, 'earpiece')).toBe('earpiece');
  });

  it('falls back to the best remaining output when the current one disappears', () => {
    expect(
      nextRoute(['bluetooth', 'speaker', 'earpiece'], ['speaker', 'earpiece'], 'bluetooth'),
    ).toBe('speaker');
  });

  it('has no route when there are no outputs', () => {
    expect(nextRoute([], [], undefined)).toBeUndefined();
  });
});

function fakePlatform(initial: string[]) {
  const platform = {
    outputs: initial,
    selected: [] as AudioOutput[],
    failSelect: false,
    list: () => Promise.resolve(platform.outputs),
    select: (output: AudioOutput) => {
      if (platform.failSelect) return Promise.reject(new Error('boom'));
      platform.selected.push(output);
      return Promise.resolve();
    },
  };
  return platform;
}

describe('AudioRoutes', () => {
  it('selects speaker on the first refresh, then Bluetooth when it connects', async () => {
    const platform = fakePlatform(['speaker', 'earpiece']);
    const routes = new AudioRoutes(platform);
    await routes.refresh();
    expect(routes.getState()).toEqual({ outputs: ['speaker', 'earpiece'], current: 'speaker' });
    platform.outputs = ['bluetooth', 'speaker', 'earpiece'];
    await routes.refresh();
    expect(routes.getState().current).toBe('bluetooth');
    expect(platform.selected).toEqual(['speaker', 'bluetooth']);
  });

  it('does not reselect when nothing changed', async () => {
    const platform = fakePlatform(['speaker', 'earpiece']);
    const routes = new AudioRoutes(platform);
    await routes.refresh();
    await routes.refresh();
    expect(platform.selected).toEqual(['speaker']);
  });

  it('applies a manual choice and keeps it across polls', async () => {
    const platform = fakePlatform(['speaker', 'earpiece']);
    const routes = new AudioRoutes(platform);
    await routes.refresh();
    await routes.choose('earpiece');
    await routes.refresh();
    expect(routes.getState().current).toBe('earpiece');
  });

  it('ignores a choice that is not available', async () => {
    const platform = fakePlatform(['speaker', 'earpiece']);
    const routes = new AudioRoutes(platform);
    await routes.refresh();
    await routes.choose('bluetooth');
    expect(routes.getState().current).toBe('speaker');
  });

  it('keeps the previous route when selecting fails, and keeps working afterwards', async () => {
    const errors: string[] = [];
    const platform = fakePlatform(['speaker', 'earpiece']);
    const routes = new AudioRoutes(platform, (detail) => errors.push(detail));
    await routes.refresh();
    platform.failSelect = true;
    await routes.choose('earpiece');
    expect(routes.getState().current).toBe('speaker');
    expect(errors).toEqual(['boom']);
    platform.failSelect = false;
    await routes.choose('earpiece');
    expect(routes.getState().current).toBe('earpiece');
  });

  it('notifies subscribers and forgets outputs on reset', async () => {
    const routes = new AudioRoutes(fakePlatform(['speaker']));
    let calls = 0;
    routes.subscribe(() => (calls += 1));
    await routes.refresh();
    routes.reset();
    expect(calls).toBe(2);
    expect(routes.getState()).toEqual({ outputs: [] });
  });
});

/** A platform whose list()/select() calls the test settles by hand. */
function heldPlatform() {
  const pending: {
    kind: 'list' | 'select';
    arg?: AudioOutput;
    settle: (v?: unknown) => void;
    fail: (e: unknown) => void;
  }[] = [];
  const platform = {
    selected: [] as AudioOutput[],
    list: () =>
      new Promise<readonly string[]>((resolve, reject) => {
        pending.push({ kind: 'list', settle: (v) => resolve(v as string[]), fail: reject });
      }),
    select: (output: AudioOutput) =>
      new Promise<void>((resolve, reject) => {
        platform.selected.push(output);
        pending.push({ kind: 'select', arg: output, settle: () => resolve(), fail: reject });
      }),
  };
  const next = () => {
    const call = pending.shift();
    if (call === undefined) throw new Error('no pending platform call');
    return call;
  };
  return { platform, next, pending };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AudioRoutes edge cases (milestone 8 verifier)', () => {
  it('a tap during a poll wins: the poll that read the old list does not undo it', async () => {
    const { platform, next } = heldPlatform();
    const routes = new AudioRoutes(platform);
    const first = routes.refresh();
    await tick();
    next().settle(['speaker', 'earpiece']);
    await tick();
    next().settle(); // select speaker
    await first;
    const poll = routes.refresh();
    const tap = routes.choose('earpiece');
    await tick();
    next().settle(['speaker', 'earpiece']); // poll's list
    await tick();
    next().settle(); // tap's select
    await Promise.all([poll, tap]);
    expect(routes.getState().current).toBe('earpiece');
    expect(platform.selected).toEqual(['speaker', 'earpiece']);
  });

  it('a list() failure keeps the state, reports it, and the next poll works', async () => {
    const errors: string[] = [];
    const platform = fakePlatform(['speaker']);
    const routes = new AudioRoutes(platform, (detail) => errors.push(detail));
    await routes.refresh();
    const list = platform.list;
    platform.list = () => Promise.reject(new Error('session stopped'));
    await routes.refresh();
    expect(routes.getState()).toEqual({ outputs: ['speaker'], current: 'speaker' });
    expect(errors).toEqual(['session stopped']);
    platform.list = list;
    platform.outputs = ['headset', 'speaker'];
    await routes.refresh();
    expect(routes.getState().current).toBe('headset');
  });

  it('a non-Error rejection is reported with a generic detail', async () => {
    const errors: string[] = [];
    const routes = new AudioRoutes(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a native bridge can reject with a non-Error
      { list: () => Promise.reject('nope'), select: () => Promise.resolve() },
      (detail) => errors.push(detail),
    );
    await routes.refresh();
    expect(errors).toEqual(['route change failed']);
  });

  it('a chosen output that vanished before select is corrected by the next poll', async () => {
    const platform = fakePlatform(['bluetooth', 'speaker', 'earpiece']);
    const routes = new AudioRoutes(platform);
    await routes.refresh();
    await routes.choose('speaker');
    platform.outputs = ['speaker', 'earpiece']; // Bluetooth dropped; sheet still lists it
    await routes.choose('bluetooth');
    await routes.refresh();
    expect(routes.getState()).toEqual({ outputs: ['speaker', 'earpiece'], current: 'speaker' });
  });

  it('a headset whose select failed is retried on the next poll', async () => {
    const platform = fakePlatform(['speaker', 'earpiece']);
    const routes = new AudioRoutes(platform);
    await routes.refresh();
    platform.outputs = ['headset', 'speaker', 'earpiece'];
    platform.failSelect = true;
    await routes.refresh();
    expect(routes.getState().current).toBe('speaker');
    platform.failSelect = false;
    await routes.refresh();
    expect(routes.getState().current).toBe('headset');
  });

  it('wired headset unplugged while Bluetooth stays: falls back to Bluetooth, not speaker', () => {
    expect(
      nextRoute(['bluetooth', 'headset', 'speaker'], ['bluetooth', 'speaker'], 'headset'),
    ).toBe('bluetooth');
  });

  it('a headset already connected when the call starts is used from the first poll', () => {
    expect(nextRoute([], ['bluetooth', 'speaker', 'earpiece'], undefined)).toBe('bluetooth');
  });

  it('the first poll of a new call after reset() applies the default again', async () => {
    const platform = fakePlatform(['speaker', 'earpiece']);
    const routes = new AudioRoutes(platform);
    await routes.refresh();
    await routes.choose('earpiece');
    routes.reset();
    await routes.refresh();
    expect(routes.getState().current).toBe('speaker');
    expect(platform.selected).toEqual(['speaker', 'earpiece', 'speaker']);
  });

  it('BUG: a poll in flight when the call ends selects an output after the call and refills state', async () => {
    // The call screen polls every 2 s; session.ts calls reset() when the call stops being active.
    // A poll whose list() is still pending then finishes against the reset state: it treats the
    // outputs as new, calls select() on the finished call's audio session, and refills the state.
    const { platform, next, pending } = heldPlatform();
    const routes = new AudioRoutes(platform);
    const first = routes.refresh();
    await tick();
    next().settle(['speaker', 'earpiece']);
    await tick();
    next().settle();
    await first;
    const poll = routes.refresh(); // last poll of the call
    await tick();
    routes.reset(); // call ended
    next().settle(['speaker', 'earpiece']);
    await tick();
    while (pending.length > 0) next().settle();
    await poll;
    expect(platform.selected).toEqual(['speaker']); // nothing selected after the call ended
    expect(routes.getState()).toEqual({ outputs: [] });
  });

  it('BUG: a route tap still selecting when the call ends carries that choice into the next call', async () => {
    const { platform, next, pending } = heldPlatform();
    const routes = new AudioRoutes(platform);
    const first = routes.refresh();
    await tick();
    next().settle(['speaker', 'earpiece']);
    await tick();
    next().settle();
    await first;
    const tap = routes.choose('earpiece');
    await tick();
    routes.reset(); // call ended while select('earpiece') is in flight
    next().settle();
    await tap;
    // Next call: LiveKit's session defaults to speaker; the first poll must say (and select) speaker.
    const poll = routes.refresh();
    await tick();
    next().settle(['speaker', 'earpiece']);
    await tick();
    while (pending.length > 0) next().settle();
    await poll;
    expect(routes.getState().current).toBe('speaker');
  });
});
