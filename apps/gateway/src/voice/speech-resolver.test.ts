import type { SpeechProvider } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { CredentialDecryptError } from '../store/cipher';
import type { SpeechKeyVault } from '../store/speech-keys';

import { SpeechKeyUnreadableError, createSpeechResolver } from './speech-resolver';

function vault(keys: Partial<Record<SpeechProvider, string>>): SpeechKeyVault {
  return {
    put: () => Promise.resolve(),
    get: (_userId, provider) => {
      // 'unreadable' stands for a key the vault cannot open.
      const key = keys[provider];
      if (key === 'unreadable') return Promise.reject(new CredentialDecryptError());
      return Promise.resolve(key);
    },
    list: () => Promise.resolve([]),
    delete: () => Promise.resolve(),
    deleteAllForUser: () => Promise.resolve(0),
    getListening: () => Promise.resolve('deepgram'),
    setListening: () => Promise.resolve(),
  };
}

const TWRING = { deepgram: { apiKey: 'twring-dg' }, cartesia: { apiKey: 'twring-ct' } };

describe('createSpeechResolver', () => {
  it("gives Twring's keys when the switch is off", async () => {
    const resolver = createSpeechResolver({
      enabled: false,
      vault: vault({ deepgram: 'own-dg-key' }),
      ...TWRING,
    });
    expect(await resolver.resolve('alice')).toEqual({
      deepgram: { apiKey: 'twring-dg', source: 'twring' },
      cartesia: { apiKey: 'twring-ct', source: 'twring' },
      listening: 'deepgram',
    });
  });

  it("uses an own Deepgram key and Twring's Cartesia key", async () => {
    const resolver = createSpeechResolver({
      enabled: true,
      vault: vault({ deepgram: 'own-dg-key' }),
      ...TWRING,
    });
    expect(await resolver.resolve('alice')).toEqual({
      deepgram: { apiKey: 'own-dg-key', source: 'own' },
      cartesia: { apiKey: 'twring-ct', source: 'twring' },
      listening: 'deepgram',
    });
  });

  it('refuses an unreadable own key by provider', async () => {
    const resolver = createSpeechResolver({
      enabled: true,
      vault: vault({ deepgram: 'unreadable' }),
      ...TWRING,
    });
    const error = await resolver.resolve('alice').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpeechKeyUnreadableError);
    expect((error as SpeechKeyUnreadableError).provider).toBe('deepgram');
  });

  it('uses an own Cartesia key when the server has none', async () => {
    const resolver = createSpeechResolver({
      enabled: true,
      vault: vault({ cartesia: 'own-ct-key' }),
      deepgram: TWRING.deepgram,
    });
    expect(await resolver.resolve('alice')).toEqual({
      deepgram: { apiKey: 'twring-dg', source: 'twring' },
      cartesia: { apiKey: 'own-ct-key', source: 'own' },
      listening: 'deepgram',
    });
  });

  it('leaves out a provider nobody has a key for', async () => {
    const resolver = createSpeechResolver({ enabled: true, vault: vault({}) });
    expect(await resolver.resolve('alice')).toEqual({ listening: 'deepgram' });
  });
});

describe('the listening provider', () => {
  function withListening(
    keys: Partial<Record<SpeechProvider, string>>,
    listening: 'deepgram' | 'xai',
  ): SpeechKeyVault {
    return { ...vault(keys), getListening: () => Promise.resolve(listening) };
  }

  it('listens on own xAI when the person chose it and has both keys', async () => {
    const resolver = createSpeechResolver({
      enabled: true,
      vault: withListening({ deepgram: 'own-dg-key', xai: 'own-xai-key' }, 'xai'),
      ...TWRING,
    });
    const speech = await resolver.resolve('alice');
    expect(speech.listening).toBe('xai');
    expect(speech.xai).toEqual({ apiKey: 'own-xai-key', source: 'own' });
    expect(speech.deepgram).toEqual({ apiKey: 'own-dg-key', source: 'own' });
  });

  it('listens on own Deepgram by default with both keys', async () => {
    const resolver = createSpeechResolver({
      enabled: true,
      vault: withListening({ deepgram: 'own-dg-key', xai: 'own-xai-key' }, 'deepgram'),
      ...TWRING,
    });
    expect((await resolver.resolve('alice')).listening).toBe('deepgram');
  });

  it('listens on own xAI when it is the only own listening key', async () => {
    const resolver = createSpeechResolver({
      enabled: true,
      vault: withListening({ xai: 'own-xai-key' }, 'xai'),
      ...TWRING,
    });
    const speech = await resolver.resolve('alice');
    expect(speech.listening).toBe('xai');
    expect(speech.deepgram).toEqual({ apiKey: 'twring-dg', source: 'twring' });
  });

  it('falls back to Deepgram when the choice is xAI but no xAI key is left', async () => {
    const resolver = createSpeechResolver({
      enabled: true,
      vault: withListening({}, 'xai'),
      ...TWRING,
    });
    const speech = await resolver.resolve('alice');
    expect(speech.listening).toBe('deepgram');
    expect(speech.xai).toBeUndefined();
  });

  it('never reads xAI keys or the choice with the switch off', async () => {
    const resolver = createSpeechResolver({
      enabled: false,
      vault: withListening({ xai: 'own-xai-key' }, 'xai'),
      ...TWRING,
    });
    const speech = await resolver.resolve('alice');
    expect(speech.listening).toBe('deepgram');
    expect(speech.xai).toBeUndefined();
  });
});

describe('a self-hosted server on its own xAI key (no Deepgram key)', () => {
  const SERVER_XAI = { xai: { apiKey: 'server-xai-key' } };
  function withListening(
    keys: Partial<Record<SpeechProvider, string>>,
    listening: 'deepgram' | 'xai',
  ): SpeechKeyVault {
    return { ...vault(keys), getListening: () => Promise.resolve(listening) };
  }

  it('listens on the server xAI key when the person has no keys, even with the switch off', async () => {
    for (const enabled of [true, false]) {
      const resolver = createSpeechResolver({
        enabled,
        vault: withListening({}, 'deepgram'),
        ...SERVER_XAI,
      });
      expect(await resolver.resolve('alice')).toEqual({
        xai: { apiKey: 'server-xai-key', source: 'twring' },
        listening: 'xai',
      });
    }
  });

  it('keeps the person’s own Deepgram listening when they chose it', async () => {
    const resolver = createSpeechResolver({
      enabled: true,
      vault: withListening({ deepgram: 'own-dg-key' }, 'deepgram'),
      ...SERVER_XAI,
    });
    const speech = await resolver.resolve('alice');
    expect(speech.listening).toBe('deepgram');
    expect(speech.deepgram).toEqual({ apiKey: 'own-dg-key', source: 'own' });
    expect(speech.xai).toEqual({ apiKey: 'server-xai-key', source: 'twring' });
  });

  it('an own xAI key wins over the server key', async () => {
    const resolver = createSpeechResolver({
      enabled: true,
      vault: withListening({ xai: 'own-xai-key' }, 'xai'),
      ...SERVER_XAI,
    });
    const speech = await resolver.resolve('alice');
    expect(speech.listening).toBe('xai');
    expect(speech.xai).toEqual({ apiKey: 'own-xai-key', source: 'own' });
  });
});
