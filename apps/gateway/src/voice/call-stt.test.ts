import { describe, expect, it } from 'vitest';

import { createCallStt } from './call-stt';
import { FakeSttProvider } from './testing';

const DEEPGRAM = {
  apiKey: 'twring-dg',
  sttModel: 'flux-general-en',
  sttLanguageHints: [],
  sttKeyterms: ['Twring'],
  sttEotThreshold: 0.7,
  sttEotTimeoutMs: 5000,
};
const XAI = { endpointingMs: 400, smartTurn: 0.5, smartTurnTimeoutMs: 900 };

function build() {
  const made: { provider: string; options: Record<string, unknown> }[] = [];
  const sttFor = createCallStt({
    deepgram: DEEPGRAM,
    xai: XAI,
    keyterms: (terms, name) => [...terms, ...(name ? [name] : [])],
    createDeepgram: (options) => {
      made.push({ provider: 'deepgram', options: { ...options } });
      return new FakeSttProvider();
    },
    createXai: (options) => {
      made.push({ provider: 'xai', options: { ...options } });
      return new FakeSttProvider();
    },
  });
  return { sttFor, made };
}

describe('createCallStt', () => {
  it('listens on xAI with the own key, the merged keyterms and the XAI_STT settings', () => {
    const { sttFor, made } = build();
    sttFor(['Acme'], 'Nova', {
      deepgram: { apiKey: 'twring-dg', source: 'twring' },
      xai: { apiKey: 'own-xai', source: 'own' },
      listening: 'xai',
    });
    expect(made).toEqual([
      {
        provider: 'xai',
        options: {
          apiKey: 'own-xai',
          keyterms: ['Acme', 'Nova'],
          endpointingMs: 400,
          smartTurn: 0.5,
          smartTurnTimeoutMs: 900,
        },
      },
    ]);
  });

  it('listens on Deepgram otherwise, on the own key when there is one', () => {
    const { sttFor, made } = build();
    sttFor(['Acme'], 'Nova', {
      deepgram: { apiKey: 'own-dg', source: 'own' },
      xai: { apiKey: 'own-xai', source: 'own' },
      listening: 'deepgram',
    });
    sttFor(['Acme'], 'Nova');
    expect(made.map((m) => [m.provider, m.options.apiKey, m.options.keyterms])).toEqual([
      ['deepgram', 'own-dg', ['Acme', 'Nova']],
      ['deepgram', 'twring-dg', ['Acme', 'Nova']],
    ]);
  });

  it('never builds xAI listening without an xAI key', () => {
    const { sttFor, made } = build();
    sttFor([], undefined, { listening: 'xai' });
    expect(made.map((m) => m.provider)).toEqual(['deepgram']);
  });
});
