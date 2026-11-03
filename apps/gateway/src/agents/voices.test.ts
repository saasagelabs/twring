import { createAgentRequestSchema, voiceListResponseSchema } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { VOICES, voiceList } from './voices';

describe('voice list against the contract', () => {
  it('every voice the gateway lists parses as the phone parses it, with or without Cartesia', () => {
    for (const cartesia of [false, true]) {
      expect(voiceListResponseSchema.safeParse(voiceList({ cartesia })).success).toBe(true);
    }
  });

  it('an agent may be saved with any listed voice', () => {
    for (const voice of VOICES) {
      const parsed = createAgentRequestSchema.safeParse({
        name: 'Agent',
        protocol: 'cord-native',
        endpoint_url: 'wss://agent.example.com',
        voice_id: voice.id,
      });
      expect({ id: voice.id, ok: parsed.success }).toEqual({ id: voice.id, ok: true });
    }
  });
});
