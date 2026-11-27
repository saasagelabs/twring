import { describe, expect, it } from 'vitest';

import type { SecureKeyValue } from '../auth/storage';
import { forgetPrivateDevice } from './private-chats';
import {
  clearVoiceConsent,
  giveVoiceConsent,
  hasVoiceConsent,
  VOICE_CONSENT_CAP,
  VOICE_CONSENT_KEY,
} from './voice-consent';

function memory(): SecureKeyValue & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItemAsync: (key) => Promise.resolve(map.get(key) ?? null),
    setItemAsync: (key, value) => Promise.resolve(void map.set(key, value)),
    deleteItemAsync: (key) => Promise.resolve(void map.delete(key)),
  };
}

describe('voice-note consent per private chat', () => {
  it('round trips per chat and clears one chat', async () => {
    const store = memory();
    expect(await hasVoiceConsent(store, 'a1')).toBe(false);
    await giveVoiceConsent(store, 'a1');
    await giveVoiceConsent(store, 'a2');
    await giveVoiceConsent(store, 'a1');
    expect(JSON.parse(store.map.get(VOICE_CONSENT_KEY) ?? '')).toEqual(['a2', 'a1']);
    expect(await hasVoiceConsent(store, 'a1')).toBe(true);
    await clearVoiceConsent(store, 'a1');
    expect(await hasVoiceConsent(store, 'a1')).toBe(false);
    expect(await hasVoiceConsent(store, 'a2')).toBe(true);
  });

  it('anything unreadable counts as no consent, and a new yes replaces it', async () => {
    for (const raw of ['not json', '{"a1":true}', '["a1", 3]', '[""]', '"a1"']) {
      const store = memory();
      store.map.set(VOICE_CONSENT_KEY, raw);
      expect(await hasVoiceConsent(store, 'a1')).toBe(false);
      await giveVoiceConsent(store, 'a2');
      expect(JSON.parse(store.map.get(VOICE_CONSENT_KEY) ?? '')).toEqual(['a2']);
    }
    const failing: SecureKeyValue = {
      getItemAsync: () => Promise.reject(new Error('locked')),
      setItemAsync: () => Promise.resolve(),
      deleteItemAsync: () => Promise.resolve(),
    };
    expect(await hasVoiceConsent(failing, 'a1')).toBe(false);
  });

  it('keeps the newest 200 chats', async () => {
    const store = memory();
    for (let i = 0; i <= VOICE_CONSENT_CAP; i++) await giveVoiceConsent(store, `a${i}`);
    const ids = JSON.parse(store.map.get(VOICE_CONSENT_KEY) ?? '') as string[];
    expect(VOICE_CONSENT_CAP).toBe(200);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe('a1');
    expect(await hasVoiceConsent(store, 'a0')).toBe(false);
    expect(await hasVoiceConsent(store, `a${VOICE_CONSENT_CAP}`)).toBe(true);
  });

  it('sign-out removes every consent', async () => {
    const store = memory();
    await giveVoiceConsent(store, 'a1');
    await forgetPrivateDevice(store);
    expect(store.map.has(VOICE_CONSENT_KEY)).toBe(false);
  });
});
