import {
  base64urlDecode,
  base64urlEncode,
  deriveSealKey,
  generateSealKeyPair,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { HOSTED_SEAL_KEY, HOSTED_SEAL_SLOT, hostedSealCalls } from './hosted-seal';
import type { RegisterDeviceRequest } from './protocol';

const REQUEST: RegisterDeviceRequest = {
  fcm_token: 'fcm-token',
  platform: 'android',
  app_variant: 'production',
};

function memoryStore(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItemAsync: vi.fn((key: string) => Promise.resolve(items.get(key) ?? null)),
    setItemAsync: vi.fn((key: string, value: string) => {
      items.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: vi.fn((key: string) => {
      items.delete(key);
      return Promise.resolve();
    }),
  };
}

function setup(server = generateSealKeyPair(), answerKey = true) {
  const store = memoryStore();
  const sealKeys = { set: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) };
  const sent: RegisterDeviceRequest[] = [];
  const unregister = vi.fn(() => Promise.resolve());
  const calls = hostedSealCalls({
    register: (_id, request) => {
      sent.push(request);
      return Promise.resolve(
        answerKey ? { seal_server_public_key: base64urlEncode(server.publicKey) } : undefined,
      );
    },
    unregister,
    store,
    sealKeys,
  });
  return { calls, store, sealKeys, sent, server, unregister };
}

describe('hosted seal registration', () => {
  it('sends the public key and stores the shared key the server can also derive', async () => {
    const t = setup();
    await t.calls.register('device-1', REQUEST);
    const phoneKey = t.sent[0]?.seal_public_key;
    expect(phoneKey).toHaveLength(43);
    const expected = base64urlEncode(
      deriveSealKey(t.server.privateKey, base64urlDecode(phoneKey!)),
    );
    expect(t.sealKeys.set).toHaveBeenCalledWith(HOSTED_SEAL_SLOT, expected);
  });

  it('makes the key pair once per install', async () => {
    const t = setup();
    await t.calls.register('device-1', REQUEST);
    await t.calls.register('device-1', REQUEST);
    expect(t.sent[0]?.seal_public_key).toBe(t.sent[1]?.seal_public_key);
    expect(t.store.setItemAsync).toHaveBeenCalledTimes(1);
    expect(t.store.items.has(HOSTED_SEAL_KEY)).toBe(true);
  });

  it('an older server (no key in the answer) clears the hosted key', async () => {
    const t = setup(generateSealKeyPair(), false);
    await t.calls.register('device-1', REQUEST);
    expect(t.sealKeys.set).not.toHaveBeenCalled();
    expect(t.sealKeys.remove).toHaveBeenCalledWith(HOSTED_SEAL_SLOT);
  });

  it('an unreadable keychain registers without a key', async () => {
    const t = setup();
    t.store.getItemAsync.mockRejectedValueOnce(new Error('locked'));
    await t.calls.register('device-1', REQUEST);
    expect(t.sent[0]).toEqual(REQUEST);
    expect(t.sealKeys.remove).toHaveBeenCalledWith(HOSTED_SEAL_SLOT);
  });

  it('a native store that refuses the key re-registers once without it', async () => {
    const t = setup();
    t.sealKeys.set.mockRejectedValueOnce(new Error('Invalid server id'));
    await t.calls.register('device-1', REQUEST);
    expect(t.sent).toHaveLength(2);
    expect(t.sent[0]?.seal_public_key).toBeDefined();
    expect(t.sent[1]).toEqual(REQUEST);
    expect(t.sealKeys.remove).toHaveBeenCalledWith(HOSTED_SEAL_SLOT);
  });

  it('sign-out clears the hosted key, even when the server call fails', async () => {
    const t = setup();
    await t.calls.unregister('device-1');
    expect(t.unregister).toHaveBeenCalledWith('device-1');
    expect(t.sealKeys.remove).toHaveBeenCalledWith(HOSTED_SEAL_SLOT);

    t.unregister.mockRejectedValueOnce(new Error('offline'));
    t.sealKeys.remove.mockClear();
    await expect(t.calls.unregister('device-1')).rejects.toThrow('offline');
    expect(t.sealKeys.remove).toHaveBeenCalledWith(HOSTED_SEAL_SLOT);
  });
});
