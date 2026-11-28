import { describe, expect, it } from 'vitest';

import { captionTail, readableReply } from './captions';

describe('captionTail', () => {
  it('keeps short text as is', () => {
    expect(captionTail('Hello there', 600)).toBe('Hello there');
  });

  it('keeps the end of long text, starting on a word, with a leading ellipsis', () => {
    const text = `${'alpha '.repeat(200)}the end`;
    const tail = captionTail(text, 50);
    expect(tail.startsWith('…alpha')).toBe(true);
    expect(tail.endsWith('the end')).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(51);
  });

  it('does not double an ellipsis the server already put on', () => {
    expect(captionTail(`…${'x'.repeat(20)} …tail`, 8)).toBe('…tail');
  });

  it('cuts mid-word when there is no space to cut at', () => {
    expect(captionTail('x'.repeat(30), 10)).toBe(`…${'x'.repeat(10)}`);
  });
});

describe('readableReply', () => {
  it('says nothing until the first sentence ends', () => {
    expect(readableReply('Sure, I can look', false)).toBe('');
  });

  it('gives the last finished sentence while words stream', () => {
    expect(readableReply('Sure. I checked the logs and', false)).toBe('Sure.');
    expect(readableReply('Sure. I checked the logs.', false)).toBe('I checked the logs.');
    expect(readableReply('Sure. I checked the logs. Then', false)).toBe('I checked the logs.');
    expect(readableReply('Really?! Wow', false)).toBe('Really?!');
    expect(readableReply('Hmm… okay', false)).toBe('Hmm…');
  });

  it('does not change while a sentence streams, so a screen reader reads it once', () => {
    const a = readableReply('Done. It took three', false);
    const b = readableReply('Done. It took three minutes and', false);
    expect(a).toBe(b);
  });

  it('ignores a decimal point and the clipped-start ellipsis', () => {
    expect(readableReply('It is 3.5 percent', false)).toBe('');
    expect(readableReply('…the build passed', false)).toBe('');
    expect(readableReply('…the build passed. Next', false)).toBe('the build passed.');
  });

  it('gives the whole reply once it is final', () => {
    expect(readableReply(' All done, nothing failed ', true)).toBe('All done, nothing failed');
  });
});
