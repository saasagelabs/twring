import { describe, expect, it } from 'vitest';

import { pickerSelection, savedVoiceLabel, savedVoiceMissing, voiceGroups } from './voice-groups';

const voice = (id: string, label: string) => ({ id, label });

describe('voice picker groups', () => {
  it('keeps one unlabelled group when there are no Grok voices', () => {
    const voices = [voice('flux-a-en', 'A'), voice('cartesia-b-en', 'B')];
    expect(voiceGroups(voices)).toEqual([{ label: undefined, voices }]);
  });

  it('puts xai voices in a Grok group after the usual ones', () => {
    const usual = voice('flux-a-en', 'A');
    const eve = voice('xai-eve-en', 'Eve · Grok');
    expect(voiceGroups([eve, usual])).toEqual([
      { label: undefined, voices: [usual] },
      { label: 'Grok', voices: [eve] },
    ]);
  });

  it('returns no groups for an empty list', () => {
    expect(voiceGroups([])).toEqual([]);
  });

  it('selects nothing when the saved voice is no longer offered', () => {
    const voices = [voice('flux-a-en', 'A')];
    expect(pickerSelection(undefined, 'xai-eve-en', voices)).toBeUndefined();
    expect(pickerSelection(undefined, 'flux-a-en', voices)).toBe('flux-a-en');
    expect(pickerSelection('flux-a-en', 'xai-eve-en', voices)).toBe('flux-a-en');
  });

  it('names a saved voice that is no longer offered as the default voice', () => {
    const voices = [voice('flux-a-en', 'A')];
    expect(savedVoiceLabel('flux-a-en', voices)).toBe('A');
    expect(savedVoiceLabel('xai-eve-en', voices)).toBe('Default voice');
    expect(savedVoiceMissing('xai-eve-en', voices)).toBe(true);
    expect(savedVoiceMissing('flux-a-en', voices)).toBe(false);
    expect(savedVoiceMissing(undefined, voices)).toBe(false);
  });
});
