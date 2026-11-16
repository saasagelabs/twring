import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-audio', () => ({ createAudioPlayer: vi.fn(), setAudioModeAsync: vi.fn() }));
vi.mock('react-native', () => ({ StyleSheet: { create: (value: unknown) => value } }));
vi.mock('@/theme/tokens', () => ({
  usePalette: vi.fn(),
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
}));
vi.mock('@/theme/fonts', () => ({ font: { caption: 'caption' } }));
vi.mock('@/components/Icon', () => ({ Icon: vi.fn() }));
vi.mock('@/api', () => ({ twringApi: vi.fn() }));

import { ApiError } from '../../api/client';

import {
  forgetListenRefusal,
  listenFailureMessage,
  listenPreflight,
  listenReducer,
  noteListenFailure,
} from './ListenButton';

describe('listen state', () => {
  it('moves through loading, playing, stop and retry after failure', () => {
    expect(listenReducer('idle', 'load')).toBe('loading');
    expect(listenReducer('loading', 'play')).toBe('playing');
    expect(listenReducer('playing', 'stop')).toBe('idle');
    expect(listenReducer('loading', 'fail')).toBe('error');
    expect(listenReducer('error', 'load')).toBe('loading');
  });
});

describe('listenFailureMessage', () => {
  it('names the fix for a refused or unreadable own key, else stays generic', () => {
    const refused = new ApiError(
      'http',
      'speech_key_refused',
      undefined,
      undefined,
      409,
      undefined,
      'Your Deepgram key was refused. Update it in Settings.',
    );
    expect(listenFailureMessage(refused)).toBe(
      'Your Deepgram key was refused. Update it in Settings.',
    );
    expect(listenFailureMessage(new ApiError('network'))).toBe("Couldn't play this. Try again.");
    expect(listenFailureMessage(undefined)).toBe("Couldn't play this. Try again.");
  });
});

const refusedKey = (): ApiError =>
  new ApiError('http', 'speech_key_refused', undefined, undefined, 409, undefined, 'Refused.');

describe('listenPreflight', () => {
  it('hands Listen straight to the player while no own key was refused', async () => {
    forgetListenRefusal();
    const probe = vi.fn(() => Promise.resolve('ok' as const));
    await expect(listenPreflight('agt_a', probe)).resolves.toBeUndefined();
    noteListenFailure('agt_a', new ApiError('network'));
    await expect(listenPreflight('agt_a', probe)).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('after a refused own key, asks the server once and shows the refusal without the player', async () => {
    forgetListenRefusal();
    noteListenFailure('agt_a', refusedKey());
    const probe = vi.fn(() => Promise.resolve(refusedKey()));
    const found = await listenPreflight('agt_a', probe);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(found?.code).toBe('speech_key_refused');
    // Still refused: the next Listen checks first again.
    await listenPreflight('agt_a', probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('once the key works again, goes back to playing straight away', async () => {
    forgetListenRefusal();
    noteListenFailure('agt_a', refusedKey());
    const probe = vi.fn(() => Promise.resolve('ok' as const));
    await expect(listenPreflight('agt_a', probe)).resolves.toBeUndefined();
    await expect(listenPreflight('agt_a', probe)).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps checking first when a check is inconclusive (network failure, other error)', async () => {
    forgetListenRefusal();
    noteListenFailure('agt_a', refusedKey());
    const probe = vi.fn(() => Promise.resolve(undefined));
    await expect(listenPreflight('agt_a', probe)).resolves.toBeUndefined();
    await listenPreflight('agt_a', probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('remembers a refusal per agent: another agent playing fine does not clear it', async () => {
    forgetListenRefusal();
    noteListenFailure('agt_a', refusedKey());
    const other = vi.fn(() => Promise.resolve('ok' as const));
    await expect(listenPreflight('agt_b', other)).resolves.toBeUndefined();
    expect(other).not.toHaveBeenCalled();
    const refused = vi.fn(() => Promise.resolve(refusedKey()));
    expect((await listenPreflight('agt_a', refused))?.code).toBe('speech_key_refused');
    expect(refused).toHaveBeenCalledTimes(1);
  });
});
