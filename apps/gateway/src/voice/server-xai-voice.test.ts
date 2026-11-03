import { describe, expect, it } from 'vitest';

import { serverXaiCallVoice, serverXaiKey, serverXaiTtsSide } from './server-xai-voice';
import type { ResolvedSpeech } from './speech-resolver';
import type { SttProvider, TtsProvider } from './types';
import type { XaiSttOptions } from './xai-stt';
import type { XaiTtsOptions } from './xai-tts';

const SERVER_KEY = 'xai-server-key-for-tests';

function recording() {
  const stt: XaiSttOptions[] = [];
  const tts: XaiTtsOptions[] = [];
  const voice = serverXaiCallVoice({
    apiKey: SERVER_KEY,
    stt: { endpointingMs: 400 },
    createStt: (options) => {
      stt.push(options);
      return { name: 'xai-stt' } as unknown as SttProvider;
    },
    createTts: (options) => {
      tts.push(options);
      return { name: 'xai-tts' } as unknown as TtsProvider;
    },
  });
  return { voice, stt, tts };
}

describe('serverXaiKey', () => {
  it('self-hosted with only an xAI key: the server speaks with xAI', () => {
    expect(
      serverXaiKey({ TWRING_MODE: 'selfhost', DEEPGRAM_API_KEY: undefined, XAI_API_KEY: 'x' }),
    ).toBe('x');
  });

  it('with both keys Deepgram is preferred', () => {
    expect(
      serverXaiKey({ TWRING_MODE: 'selfhost', DEEPGRAM_API_KEY: 'd', XAI_API_KEY: 'x' }),
    ).toBeUndefined();
  });

  it('Deepgram only, and hosted Twring, are unchanged', () => {
    expect(
      serverXaiKey({ TWRING_MODE: 'selfhost', DEEPGRAM_API_KEY: 'd', XAI_API_KEY: undefined }),
    ).toBeUndefined();
    expect(
      serverXaiKey({ TWRING_MODE: 'hosted', DEEPGRAM_API_KEY: undefined, XAI_API_KEY: 'x' }),
    ).toBeUndefined();
  });
});

describe('serverXaiCallVoice', () => {
  it('a call with no personal keys listens and speaks on the server xAI key', () => {
    const { voice, stt, tts } = recording();
    expect(voice.voice.stt.name).toBe('xai-stt');
    expect(voice.voice.tts.name).toBe('xai-tts');
    stt.length = 0;
    tts.length = 0;
    voice.sttForKeyterms(['Chennai'], 'Juno');
    voice.ttsForVoice('flux-aura-en');
    expect(stt).toHaveLength(1);
    expect(stt[0]!.apiKey).toBe(SERVER_KEY);
    expect(stt[0]!.keyterms).toEqual(expect.arrayContaining(['stop', 'Chennai', 'Juno']));
    expect(tts).toEqual([{ apiKey: SERVER_KEY, voice: 'eve' }]);
  });

  it("speaks in the agent's Grok voice", () => {
    const { voice, tts } = recording();
    tts.length = 0;
    voice.ttsForVoice('xai-rex-en');
    expect(tts).toEqual([{ apiKey: SERVER_KEY, voice: 'rex' }]);
  });

  it("uses the person's own xAI key when they saved one", () => {
    const { voice, stt, tts } = recording();
    stt.length = 0;
    tts.length = 0;
    const speech = {
      xai: { apiKey: 'own-xai', source: 'own' as const },
      listening: 'xai' as const,
    };
    voice.sttForKeyterms([], undefined, speech);
    voice.ttsForVoice('xai-ara-en', speech);
    expect(stt[0]!.apiKey).toBe('own-xai');
    expect(tts).toEqual([{ apiKey: 'own-xai', voice: 'ara' }]);
  });

  it('listens on the server key when the person chose Deepgram listening', () => {
    const { voice, stt, tts } = recording();
    stt.length = 0;
    tts.length = 0;
    const speech = {
      xai: { apiKey: 'own-xai', source: 'own' as const },
      listening: 'deepgram' as const,
    };
    voice.sttForKeyterms([], undefined, speech);
    voice.ttsForVoice('xai-ara-en', speech);
    expect(stt[0]!.apiKey).toBe(SERVER_KEY);
    expect(tts).toEqual([{ apiKey: 'own-xai', voice: 'ara' }]);
  });

  it('tells the call registry both sides run on xAI', () => {
    expect(recording().voice.speaksServerXai).toBe(true);
  });
});

describe('serverXaiCallVoice with the person’s own keys', () => {
  function withOwnKeys() {
    const made: string[] = [];
    const voice = serverXaiCallVoice({
      apiKey: SERVER_KEY,
      stt: { endpointingMs: 400 },
      createStt: (options) => {
        made.push(`xai-stt:${options.apiKey}`);
        return { name: 'xai-stt' } as unknown as SttProvider;
      },
      createTts: (options) => {
        made.push(`xai-tts:${options.apiKey}:${options.voice}`);
        return { name: 'xai-tts' } as unknown as TtsProvider;
      },
      ownKeys: {
        stt: (terms, name, speech) => {
          made.push(`deepgram-stt:${speech?.deepgram?.apiKey}:${terms.join(',')}:${name}`);
          return { name: 'deepgram-stt' } as unknown as SttProvider;
        },
        tts: {
          forSample: (voiceId, speech) => {
            const key = voiceId.startsWith('cartesia')
              ? speech?.cartesia?.apiKey
              : speech?.deepgram?.apiKey;
            made.push(`tts:${voiceId}:${key}`);
            return { name: voiceId } as unknown as TtsProvider;
          },
        },
      },
    });
    made.length = 0;
    return { voice, made };
  }
  const ownDg: ResolvedSpeech = {
    deepgram: { apiKey: 'own-dg', source: 'own' },
    xai: { apiKey: SERVER_KEY, source: 'twring' },
    listening: 'deepgram',
  };
  const serverCartesia: ResolvedSpeech = {
    cartesia: { apiKey: 'server-ct', source: 'twring' },
    xai: { apiKey: SERVER_KEY, source: 'twring' },
    listening: 'xai',
  };

  it('an own Deepgram voice speaks on the own key', () => {
    const { voice, made } = withOwnKeys();
    expect(voice.ttsForVoice('flux-haley-en', ownDg).name).toBe('flux-haley-en');
    expect(made).toEqual(['tts:flux-haley-en:own-dg']);
  });

  it('Deepgram listening with an own Deepgram key listens on Deepgram with the agent words', () => {
    const { voice, made } = withOwnKeys();
    expect(voice.sttForKeyterms(['Chennai'], 'Juno', ownDg).name).toBe('deepgram-stt');
    expect(made).toEqual(['deepgram-stt:own-dg:Chennai:Juno']);
  });

  it('a server Cartesia voice speaks on the server Cartesia key', () => {
    const { voice, made } = withOwnKeys();
    voice.ttsForVoice('cartesia-janvi-en', serverCartesia);
    expect(made).toContain('tts:cartesia-janvi-en:server-ct');
  });

  it('a voice nobody can speak is Eve on the server key', () => {
    const { voice, made } = withOwnKeys();
    voice.ttsForVoice('flux-haley-en', serverCartesia);
    voice.ttsForVoice('cartesia-janvi-en', { xai: ownDg.xai!, listening: 'xai' });
    expect(made).toEqual([`xai-tts:${SERVER_KEY}:eve`, `xai-tts:${SERVER_KEY}:eve`]);
  });

  it('names the provider each voice runs on', () => {
    expect(serverXaiTtsSide('flux-haley-en', ownDg)).toBe('deepgram');
    expect(serverXaiTtsSide('flux-haley-en', serverCartesia)).toBe('xai');
    expect(serverXaiTtsSide('cartesia-janvi-en', serverCartesia)).toBe('cartesia');
    expect(serverXaiTtsSide('xai-rex-en', ownDg)).toBe('xai');
  });
});
