import { describe, expect, it } from 'vitest';

import { addKeyterm, keytermSummary, removeKeyterm, sameKeyterms, splitKeyterms } from './keyterms';

describe('keyterms', () => {
  it('adds a trimmed word', () => {
    expect(addKeyterm(['Priya'], '  Chennai ')).toEqual({ ok: true, terms: ['Priya', 'Chennai'] });
  });

  it('refuses blank, duplicate, too long, unsafe, and a full list', () => {
    expect(addKeyterm([], '   ').ok).toBe(false);
    expect(addKeyterm(['Chennai'], 'chennai')).toEqual({
      ok: false,
      error: 'chennai is already on the list.',
    });
    expect(addKeyterm([], 'x'.repeat(51)).ok).toBe(false);
    expect(addKeyterm([], 'a‮b').ok).toBe(false);
    const full = Array.from({ length: 40 }, (_, i) => `t${i}`);
    expect(addKeyterm(full, 'Madurai').ok).toBe(false);
  });

  it('adds each word of a comma-separated list, skipping ones already there', () => {
    expect(addKeyterm(['Vellore'], 'Chennai, Coimbatore,Vellore ; Bengaluru\nOoty')).toEqual({
      ok: true,
      terms: ['Vellore', 'Chennai', 'Coimbatore', 'Bengaluru', 'Ooty'],
    });
    expect(addKeyterm(['Chennai'], 'chennai, CHENNAI')).toEqual({
      ok: false,
      error: 'chennai is already on the list.',
    });
    expect(addKeyterm([], ' , ;').ok).toBe(false);
    expect(addKeyterm([], `Chennai, ${'x'.repeat(51)}`).ok).toBe(false);
    const nearlyFull = Array.from({ length: 39 }, (_, i) => `t${i}`);
    expect(addKeyterm(nearlyFull, 'Madurai, Salem').ok).toBe(false);
  });

  it('splits a list that was saved as one entry', () => {
    expect(splitKeyterms(['Chennai, Coimbatore, Vellore, Bengaluru', 'chennai', 'Priya'])).toEqual([
      'Chennai',
      'Coimbatore',
      'Vellore',
      'Bengaluru',
      'Priya',
    ]);
  });

  it('removes and summarises', () => {
    expect(removeKeyterm(['a', 'b'], 'a')).toEqual(['b']);
    expect(keytermSummary([])).toBe('None yet');
    expect(keytermSummary(['a', 'b'])).toBe('a, b');
    expect(keytermSummary(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c +2');
    expect(sameKeyterms(['a'], ['a'])).toBe(true);
    expect(sameKeyterms(['a'], ['b'])).toBe(false);
  });
});

describe('keyterms (milestone 9 verifier)', () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);

  it('treats NFC and NFD spellings as the same word, and adds the canonical one', () => {
    const composed = `Caf${cp(0xe9)}`;
    const decomposed = `Cafe${cp(0x301)}`;
    expect(addKeyterm([composed], decomposed).ok).toBe(false);
    expect(addKeyterm([], decomposed)).toEqual({ ok: true, terms: [composed] });
  });

  it('refuses the bidi marks and separators the gateway refuses', () => {
    for (const point of [0x200f, 0x2028]) {
      expect(addKeyterm([], `a${cp(point)}b`).ok).toBe(false);
    }
  });
});
