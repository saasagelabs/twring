import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-audio', () => ({ createAudioPlayer: vi.fn(), setAudioModeAsync: vi.fn() }));
vi.mock('react-native', () => ({ StyleSheet: { create: (value: unknown) => value } }));
vi.mock('@/theme/tokens', () => ({ usePalette: vi.fn() }));
vi.mock('@/theme/fonts', () => ({ font: { caption: 'caption' } }));
vi.mock('@/components/Icon', () => ({ Icon: vi.fn() }));
vi.mock('@/api', () => ({ twringApi: vi.fn() }));

import { ApiError } from '../../api/client';

import { listenFailureMessage, listenReducer } from './ListenButton';

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
