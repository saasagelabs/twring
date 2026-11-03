import { describe, expect, it } from 'vitest';

import {
  LISTENING_PROVIDERS,
  SPEECH_PROVIDERS,
  addedLine,
  keyRefusedCallMessage,
  listeningChoiceShown,
  providerCovers,
  providerLabel,
  removeConfirmMessage,
} from './voice-accounts';

describe('voice accounts helpers', () => {
  it('names providers and what they cover', () => {
    expect(providerLabel('deepgram')).toBe('Deepgram');
    expect(providerLabel('cartesia')).toBe('Cartesia');
    expect(providerCovers('deepgram')).toBe('Listening and voice');
    expect(providerCovers('cartesia')).toBe('Voice');
  });

  it('formats the added line with the date and last four characters', () => {
    const line = addedLine({
      last4: '4f2a',
      added_at: '2026-10-27T10:00:00.000Z',
    });
    expect(line).toBe('Added on 27 Oct · ends in 4f2a');
  });

  it('says what removing does and why a call ended', () => {
    expect(removeConfirmMessage('deepgram')).toBe(
      "Remove your Deepgram key? Twring's own voice account is used again.",
    );
    expect(keyRefusedCallMessage('cartesia')).toBe(
      'Your Cartesia key was refused, so the call ended. Update it in Settings, Your own voice accounts.',
    );
  });

  it('lists xAI as a third provider for listening and voice', () => {
    expect(SPEECH_PROVIDERS).toEqual(['deepgram', 'cartesia', 'xai']);
    expect(providerLabel('xai')).toBe('xAI');
    expect(providerCovers('xai')).toBe('Listening and voice');
    expect(keyRefusedCallMessage('xai')).toBe(
      'Your xAI key was refused, so the call ended. Update it in Settings, Your own voice accounts.',
    );
  });

  it('shows the listening choice only when the server says both keys are saved', () => {
    expect(LISTENING_PROVIDERS).toEqual(['deepgram', 'xai']);
    expect(listeningChoiceShown({ listening: 'deepgram', listening_choice: true })).toBe(true);
    expect(listeningChoiceShown({ listening: 'deepgram', listening_choice: false })).toBe(false);
    expect(listeningChoiceShown(undefined)).toBe(false);
  });
});
