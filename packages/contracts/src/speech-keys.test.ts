import { describe, expect, it } from 'vitest';
import { callErrorCodeSchema } from './call-state';
import { errorCodeSchema } from './errors';
import { gatewayEndReasonSchema } from './realtime';
import { voiceIdSchema } from './agents';
import {
  listeningProviderSchema,
  speechKeyListResponseSchema,
  speechKeyPutRequestSchema,
  speechListeningPutRequestSchema,
  speechProviderSchema,
} from './speech-keys';

const KEY = 'a'.repeat(40);

describe('speechKeyPutRequestSchema', () => {
  it('trims surrounding whitespace', () => {
    expect(speechKeyPutRequestSchema.parse({ key: `  ${KEY}\n` }).key).toBe(KEY);
  });
  it('rejects too short and too long keys', () => {
    expect(speechKeyPutRequestSchema.safeParse({ key: 'a'.repeat(19) }).success).toBe(false);
    expect(speechKeyPutRequestSchema.safeParse({ key: 'a'.repeat(201) }).success).toBe(false);
    expect(speechKeyPutRequestSchema.safeParse({ key: 'a'.repeat(20) }).success).toBe(true);
    expect(speechKeyPutRequestSchema.safeParse({ key: 'a'.repeat(200) }).success).toBe(true);
  });
  it('rejects a space or newline inside the key', () => {
    expect(speechKeyPutRequestSchema.safeParse({ key: `${KEY} ${KEY}` }).success).toBe(false);
    expect(speechKeyPutRequestSchema.safeParse({ key: `${KEY}\n${KEY}` }).success).toBe(false);
  });
  it('rejects extra fields', () => {
    expect(speechKeyPutRequestSchema.safeParse({ key: KEY, extra: 1 }).success).toBe(false);
  });
});

describe('speechKeyListResponseSchema', () => {
  it('accepts a provider with no key and one with a key', () => {
    const at = '2026-10-27T10:00:00.000Z';
    const parsed = speechKeyListResponseSchema.parse({
      listening: 'deepgram',
      listening_choice: false,
      providers: [
        { provider: 'deepgram', added: null },
        { provider: 'cartesia', added: { last4: 'abcd', added_at: at, verified_at: at } },
      ],
    });
    expect(parsed.providers).toHaveLength(2);
  });
});

describe('xAI additions', () => {
  it('accepts xai as a provider and a listening provider', () => {
    expect(speechProviderSchema.parse('xai')).toBe('xai');
    expect(listeningProviderSchema.parse('xai')).toBe('xai');
    expect(listeningProviderSchema.safeParse('cartesia').success).toBe(false);
  });
  it('requires listening and listening_choice in the list response', () => {
    const base = { providers: [{ provider: 'xai', added: null }] };
    expect(speechKeyListResponseSchema.safeParse(base).success).toBe(false);
    expect(
      speechKeyListResponseSchema.safeParse({ ...base, listening: 'xai', listening_choice: true })
        .success,
    ).toBe(true);
  });
  it('validates the listening put request strictly', () => {
    expect(speechListeningPutRequestSchema.safeParse({ provider: 'xai' }).success).toBe(true);
    expect(speechListeningPutRequestSchema.safeParse({ provider: 'cartesia' }).success).toBe(false);
    expect(speechListeningPutRequestSchema.safeParse({ provider: 'xai', x: 1 }).success).toBe(
      false,
    );
  });
  it('accepts xai voice ids only in lower case', () => {
    expect(voiceIdSchema.safeParse('xai-eve-en').success).toBe(true);
    expect(voiceIdSchema.safeParse('xai-EVE-en').success).toBe(false);
  });
  it('accepts the xai end reason', () => {
    expect(gatewayEndReasonSchema.parse('xai_key_refused')).toBe('xai_key_refused');
  });
});

describe('new codes', () => {
  it('are accepted by the shared enums', () => {
    expect(callErrorCodeSchema.parse('SPEECH_KEY_REFUSED')).toBe('SPEECH_KEY_REFUSED');
    expect(gatewayEndReasonSchema.parse('cartesia_key_refused')).toBe('cartesia_key_refused');
    expect(gatewayEndReasonSchema.parse('deepgram_key_refused')).toBe('deepgram_key_refused');
    for (const c of [
      'speech_keys_disabled',
      'speech_key_invalid',
      'speech_key_refused',
      'speech_key_check_failed',
      'speech_key_unreadable',
    ]) {
      expect(errorCodeSchema.parse(c)).toBe(c);
    }
  });
});
