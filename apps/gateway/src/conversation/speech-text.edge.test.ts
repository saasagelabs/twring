import { describe, expect, it } from 'vitest';

import { SpeechTextFilter } from './speech-text';

function speak(deltas: string[]): { pieces: string[]; text: string } {
  const filter = new SpeechTextFilter();
  const pieces = deltas.map((delta) => filter.push(delta));
  pieces.push(filter.end());
  return { pieces, text: pieces.join('') };
}
const whole = (s: string) => speak([s]).text;
const chars = (s: string) => speak([...s]).text;

describe('SpeechTextFilter edge cases', () => {
  it.each([
    ['use a | b here', 'use a b here'],
    ['pages 3---5 only', 'pages 3---5 only'],
    ['it is a - b now', 'it is a - b now'],
    ['costs 3.5 dollars at example.com.', 'costs 3.5 dollars at example.com.'],
    ['-5 degrees outside', '-5 degrees outside'],
    ['Twring™ © 2026', 'Twring 2026'],
    ['Say 你好。Then go', 'Say 你好。Then go'],
  ])('keeps %j sensible in any split', (input, want) => {
    expect(whole(input)).toBe(want);
    expect(chars(input)).toBe(want);
  });

  it('speaks a table row with no trailing newline at end', () => {
    expect(chars('| Free | 0 |')).toBe('Free, 0');
  });

  it('reads a non-table line starting with | as words', () => {
    expect(chars('| grep foo is a pipe\nnext')).toBe('grep foo is a pipe. next');
  });

  it('releases a bullet list word by word, not held until newline', () => {
    const { pieces } = speak(['- first ', 'item ', 'here']);
    expect(pieces[1]).not.toBe('');
  });

  it('releases CJK at sentence end without waiting', () => {
    const { pieces } = speak(['你好。', '再见']);
    expect(pieces[0]).toBe('你好。');
  });

  it('drops separator then continues', () => {
    expect(chars('Hi\n---\nThere')).toBe('Hi. There');
  });
});

describe('SpeechTextFilter more edges', () => {
  it.each([
    ['if a || b then x -> y', 'if a b then x -> y'],
    ['* star item\n* two', 'star item. two'],
    ['1️⃣ one 👍🏽 ok 🇮🇳', '1 one ok '],
  ])('%j', (input, want) => {
    expect(whole(input)).toBe(want);
    expect(chars(input)).toBe(want);
  });
});
