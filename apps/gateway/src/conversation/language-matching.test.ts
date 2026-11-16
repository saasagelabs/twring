import { describe, expect, it } from 'vitest';

import { isFloorControl } from './controller';
import { audibleSpan, echoWords } from './echo';

describe('Hindi matching', () => {
  it("'रुको ज़रा' alone is floor control in a Hindi call", () => {
    expect(isFloorControl(echoWords('रुको ज़रा'), 'hi')).toBe(true);
  });

  it('audible span never starts or ends on a combining mark inside a word', () => {
    const text = 'नमस्ते मैं आपकी मदद कर सकता हूँ';
    const marks = /\p{M}/u;
    for (let total = 200; total <= 4000; total += 37) {
      for (let played = 0; played <= total; played += 11) {
        const { start, end } = audibleSpan(text, played, total);
        expect(marks.test(text[start] ?? '')).toBe(false);
        expect(marks.test(text[end] ?? '')).toBe(false);
      }
    }
  });
});
