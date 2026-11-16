import { describe, expect, it } from 'vitest';

import { approvalPrompt, approvalVoiceDecision } from './approvals';

describe('approval words in the person language', () => {
  it('Hindi yes with and without chandrabindu', () => {
    expect(approvalVoiceDecision('हाँ', undefined, 'hi')).toBe('approve');
    expect(approvalVoiceDecision('हां', undefined, 'hi')).toBe('approve');
  });
  it('Hindi no', () => {
    expect(approvalVoiceDecision('नहीं', undefined, 'hi')).toBe('deny');
  });
  it('echo of the Hindi prompt is not an answer', () => {
    expect(
      approvalVoiceDecision(approvalPrompt('Claude', 'edit_files', 'hi'), 'Claude', 'hi'),
    ).toBeUndefined();
  });
  it('Spanish no inside a long sentence is not decided', () => {
    expect(
      approvalVoiceDecision('no sé qué hacer con esto ahora', undefined, 'es'),
    ).toBeUndefined();
  });
  it('polite words around a Spanish or Hindi answer still decide', () => {
    expect(approvalVoiceDecision('Sí, por favor', 'Juno', 'es')).toBe('approve');
    expect(approvalVoiceDecision('No, gracias', 'Juno', 'es')).toBe('deny');
    expect(approvalVoiceDecision('हाँ, प्लीज़', 'Juno', 'hi')).toBe('approve');
    expect(approvalVoiceDecision('नहीं, धन्यवाद', 'Juno', 'hi')).toBe('deny');
    // A language's fillers alone never decide, and stay out of other calls.
    expect(approvalVoiceDecision('por favor', 'Juno', 'es')).toBeUndefined();
    expect(approvalVoiceDecision('yes gracias', 'Juno', 'en')).toBeUndefined();
  });

  it('French oui is not decided', () => {
    expect(approvalVoiceDecision('oui', undefined, 'fr')).toBeUndefined();
  });
  it('English unchanged and decomposed accents still one word', () => {
    expect(approvalVoiceDecision('yes')).toBe('approve');
    expect(approvalVoiceDecision('no thanks')).toBe('deny');
  });
});
