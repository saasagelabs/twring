import { describe, expect, it } from 'vitest';

import type { Timers } from '../call/timers';

import {
  PREVIEW_START_TIMEOUT_MS,
  VoicePreview,
  type PreviewPlayerFactory,
  type PreviewPlayerStatus,
} from './voice-preview';

function setup(
  options: {
    failCreate?: boolean;
    url?: boolean;
    probe?: (id: string) => Promise<string | undefined>;
  } = {},
) {
  let now = 0;
  const timeouts = new Set<{ at: number; callback: () => void }>();
  const timers: Timers = {
    now: () => now,
    setTimeout(callback, ms) {
      const entry = { at: now + ms, callback };
      timeouts.add(entry);
      return () => timeouts.delete(entry);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const entry of [...timeouts]) {
      if (entry.at <= now) {
        timeouts.delete(entry);
        entry.callback();
      }
    }
  };
  const players: {
    uri: string;
    emit: (status: PreviewPlayerStatus) => void;
    played: boolean;
    released: boolean;
  }[] = [];
  const factory: PreviewPlayerFactory = {
    create(uri, onStatus) {
      if (options.failCreate === true) throw new Error('native');
      const player = { uri, emit: onStatus, played: false, released: false };
      players.push(player);
      return {
        play: () => (player.played = true),
        release: () => (player.released = true),
      };
    },
  };
  const preview = new VoicePreview(
    factory,
    (id) => (options.url === false ? undefined : `https://cord.test/v1/voices/${id}/sample`),
    timers,
    options.probe,
  );
  return { preview, players, advance, timeouts };
}

describe('VoicePreview', () => {
  it('loads, plays, and returns to idle when the sample finishes', () => {
    const { preview, players } = setup();
    preview.toggle('flux-kit-en');
    expect(preview.getState()).toEqual({ status: 'loading', voiceId: 'flux-kit-en' });
    expect(players[0]).toMatchObject({ uri: 'https://cord.test/v1/voices/flux-kit-en/sample' });
    expect(players[0].played).toBe(true);
    players[0].emit({ playing: true, finished: false });
    expect(preview.getState()).toEqual({ status: 'playing', voiceId: 'flux-kit-en' });
    players[0].emit({ playing: false, finished: true });
    expect(preview.getState()).toEqual({ status: 'idle' });
    expect(players[0].released).toBe(true);
  });

  it('tapping the playing voice stops it; tapping another switches and releases the first', () => {
    const { preview, players } = setup();
    preview.toggle('a');
    players[0].emit({ playing: true, finished: false });
    preview.toggle('b');
    expect(players[0].released).toBe(true);
    expect(preview.getState()).toEqual({ status: 'loading', voiceId: 'b' });
    // A late status from the released player changes nothing.
    players[0].emit({ playing: false, finished: true });
    expect(preview.getState()).toEqual({ status: 'loading', voiceId: 'b' });
    preview.toggle('b');
    expect(preview.getState()).toEqual({ status: 'idle' });
    expect(players[1].released).toBe(true);
  });

  it('stop is idempotent and clears the start timeout', () => {
    const { preview, timeouts } = setup();
    preview.toggle('a');
    preview.stop();
    preview.stop();
    expect(preview.getState()).toEqual({ status: 'idle' });
    expect(timeouts.size).toBe(0);
  });

  it('fails a sample that never starts, and one the player cannot open', () => {
    const slow = setup();
    slow.preview.toggle('a');
    slow.advance(PREVIEW_START_TIMEOUT_MS);
    expect(slow.preview.getState()).toEqual({ status: 'failed', voiceId: 'a' });
    expect(slow.players[0].released).toBe(true);

    const broken = setup({ failCreate: true });
    broken.preview.toggle('a');
    expect(broken.preview.getState()).toEqual({ status: 'failed', voiceId: 'a' });

    const unconfigured = setup({ url: false });
    unconfigured.preview.toggle('a');
    expect(unconfigured.preview.getState()).toEqual({ status: 'failed', voiceId: 'a' });
  });

  it('retrying a failed voice plays it again', () => {
    const { preview, players, advance } = setup();
    preview.toggle('a');
    advance(PREVIEW_START_TIMEOUT_MS);
    preview.toggle('a');
    expect(preview.getState()).toEqual({ status: 'loading', voiceId: 'a' });
    expect(players).toHaveLength(2);
  });
});

describe('VoicePreview (milestone 9 verifier)', () => {
  it('rapid toggling and switching leaves exactly one live player and one timeout', () => {
    const { preview, players, timeouts } = setup();
    for (const id of ['a', 'b', 'a', 'b', 'c', 'c', 'a']) preview.toggle(id);
    expect(preview.getState()).toEqual({ status: 'loading', voiceId: 'a' });
    expect(players.filter((p) => !p.released)).toHaveLength(1);
    expect(players.at(-1)!.released).toBe(false);
    expect(timeouts.size).toBe(1);
    // Every stale player reporting late changes nothing.
    for (const stale of players.slice(0, -1)) {
      stale.emit({ playing: true, finished: false });
      stale.emit({ playing: false, finished: true });
    }
    expect(preview.getState()).toEqual({ status: 'loading', voiceId: 'a' });
  });

  it('a start timeout never fires once playback began, and a late start after it is ignored', () => {
    const playing = setup();
    playing.preview.toggle('a');
    playing.players[0].emit({ playing: true, finished: false });
    playing.advance(PREVIEW_START_TIMEOUT_MS * 2);
    expect(playing.preview.getState()).toEqual({ status: 'playing', voiceId: 'a' });
    expect(playing.timeouts.size).toBe(0);

    const late = setup();
    late.preview.toggle('a');
    late.advance(PREVIEW_START_TIMEOUT_MS);
    late.players[0].emit({ playing: true, finished: false });
    expect(late.preview.getState()).toEqual({ status: 'failed', voiceId: 'a' });
  });

  it('leaving the screen while loading releases the player and ignores its later status', () => {
    const { preview, players, timeouts } = setup();
    const seen: string[] = [];
    preview.subscribe(() => seen.push(preview.getState().status));
    preview.toggle('a');
    preview.stop(); // the screen's blur/unmount cleanup
    players[0].emit({ playing: true, finished: false });
    expect(preview.getState()).toEqual({ status: 'idle' });
    expect(players[0].released).toBe(true);
    expect(timeouts.size).toBe(0);
    expect(seen).toEqual(['loading', 'idle']);
  });

  it('a player whose release throws still leaves the preview idle and usable', () => {
    const { preview } = setup();
    const throwing = new VoicePreview(
      {
        create: () => ({
          play: () => undefined,
          release: () => {
            throw new Error('already released');
          },
        }),
      },
      (id) => `https://cord.test/${id}`,
      { now: () => 0, setTimeout: () => () => undefined },
    );
    throwing.toggle('a');
    throwing.toggle('b');
    throwing.stop();
    expect(throwing.getState()).toEqual({ status: 'idle' });
    expect(preview.getState()).toEqual({ status: 'idle' });
  });

  it('a player that fails on play() is released and reported failed', () => {
    let released = false;
    const preview = new VoicePreview(
      {
        create: () => ({
          play: () => {
            throw new Error('no audio focus');
          },
          release: () => (released = true),
        }),
      },
      (id) => `https://cord.test/${id}`,
      { now: () => 0, setTimeout: () => () => undefined },
    );
    preview.toggle('a');
    expect(preview.getState()).toEqual({ status: 'failed', voiceId: 'a' });
    expect(released).toBe(true);
  });
});

describe('VoicePreview failure probe', () => {
  it('adds the server reason to a failed sample, and ignores it after a restart', async () => {
    const { preview, players } = setup({
      probe: () => Promise.resolve('Your Cartesia key was refused. Update it in Settings.'),
    });
    preview.toggle('flux-kit-en');
    players[0]?.emit({ playing: false, finished: false, failed: true });
    expect(preview.getState()).toEqual({ status: 'failed', voiceId: 'flux-kit-en' });
    await Promise.resolve();
    await Promise.resolve();
    expect(preview.getState()).toEqual({
      status: 'failed',
      voiceId: 'flux-kit-en',
      message: 'Your Cartesia key was refused. Update it in Settings.',
    });
  });

  it('does not probe when the app gave up waiting (the server may still be making the sample)', async () => {
    let probed = 0;
    const { preview, advance } = setup({
      probe: () => {
        probed += 1;
        return Promise.resolve('Your Cartesia key was refused. Update it in Settings.');
      },
    });
    preview.toggle('flux-kit-en');
    advance(PREVIEW_START_TIMEOUT_MS);
    await Promise.resolve();
    expect(preview.getState()).toEqual({ status: 'failed', voiceId: 'flux-kit-en' });
    expect(probed).toBe(0);
  });
});
