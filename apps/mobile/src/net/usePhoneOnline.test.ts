import { describe, expect, it, vi } from 'vitest';

// The library's own jest mock.
vi.mock('@react-native-community/netinfo', async () => {
  vi.stubGlobal('jest', vi);
  // @ts-expect-error The library ships its jest mock without types.
  const imported: unknown = await import('@react-native-community/netinfo/jest/netinfo-mock.js');
  return imported as object;
});

const { phoneOnlineFrom, PHONE_OFFLINE_LABEL } = await import('./usePhoneOnline');

describe('phoneOnlineFrom', () => {
  it('is offline only when the phone reports no connection', () => {
    expect(phoneOnlineFrom({ isConnected: false })).toBe(false);
    expect(phoneOnlineFrom({ isConnected: true })).toBe(true);
  });

  it('treats an unknown connection as online so the header does not flicker', () => {
    expect(phoneOnlineFrom({ isConnected: null })).toBe(true);
  });

  it('uses plain words', () => {
    expect(PHONE_OFFLINE_LABEL).toBe('Waiting for network');
  });
});
