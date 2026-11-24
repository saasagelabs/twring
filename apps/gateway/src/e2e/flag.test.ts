import { describe, expect, it } from 'vitest';

import { privateChatsAllowed } from './flag';

describe('privateChatsAllowed', () => {
  it('is off by default', () => {
    expect(
      privateChatsAllowed({ PRIVATE_CHATS_ENABLED: false, PRIVATE_CHATS_USERS: undefined }, 'u1'),
    ).toBe(false);
  });
  it('stays off for a listed user while the flag is off', () => {
    expect(
      privateChatsAllowed({ PRIVATE_CHATS_ENABLED: false, PRIVATE_CHATS_USERS: ['u1'] }, 'u1'),
    ).toBe(false);
  });
  it('honours the allowlist', () => {
    const env = { PRIVATE_CHATS_ENABLED: true, PRIVATE_CHATS_USERS: ['owner'] };
    expect(privateChatsAllowed(env, 'owner')).toBe(true);
    expect(privateChatsAllowed(env, 'u2')).toBe(false);
  });
  it('opens to all when enabled without a list', () => {
    expect(
      privateChatsAllowed({ PRIVATE_CHATS_ENABLED: true, PRIVATE_CHATS_USERS: undefined }, 'u2'),
    ).toBe(true);
  });
});
