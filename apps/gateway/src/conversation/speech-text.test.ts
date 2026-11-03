import { describe, expect, it } from 'vitest';

import { SpeechTextFilter } from './speech-text';

/** Feeds `deltas` one at a time and returns every piece released, plus the end() remainder. */
function speak(deltas: string[]): { pieces: string[]; text: string } {
  const filter = new SpeechTextFilter();
  const pieces = deltas.map((delta) => filter.push(delta));
  pieces.push(filter.end());
  return { pieces, text: pieces.join('') };
}

describe('SpeechTextFilter', () => {
  it('releases whole words as soon as the next space arrives', () => {
    const { pieces, text } = speak(['Hel', 'lo there', ', how', ' are you?']);
    expect(pieces).toEqual(['', 'Hello ', 'there, ', 'how are ', 'you?']);
    expect(text).toBe('Hello there, how are you?');
  });

  it('passes plain text through unchanged, in any split', () => {
    const source = 'It is 3.5 degrees in St. Louis, e.g. cold. Right?';
    for (let size = 1; size <= 7; size += 1) {
      const deltas = source.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g'))!;
      expect(speak(deltas).text).toBe(source);
    }
  });

  it('drops markdown emphasis, headings, bullets, quotes and inline code ticks', () => {
    const { text } = speak([
      '## Plan\n',
      '- **first** step\n',
      '* _second_ step\n',
      '> quoted `npm test` here',
    ]);
    expect(text).toBe('Plan. first step. second step. quoted npm test here');
  });

  it('keeps a link held until complete, then speaks only its text', () => {
    const filter = new SpeechTextFilter();
    expect(filter.push('See the [release ')).toBe('See the ');
    expect(filter.push('notes](https://exa')).toBe('');
    expect(filter.push('mple.com/x) today.')).toBe('release notes ');
    expect(filter.end()).toBe('today.');
  });

  it('says "link" instead of reading a URL', () => {
    expect(speak(['Go to https://example.com/a?b=c now']).text).toBe('Go to link now');
  });

  it('skips fenced code blocks entirely', () => {
    const { text } = speak([
      'Run this:\n```bash\n',
      'rm -rf build\n',
      'pnpm i\n```\n',
      'Then retry.',
    ]);
    expect(text).toBe('Run this: Then retry.');
  });

  it('keeps snake_case identifiers and plain brackets', () => {
    expect(speak(['Set max_retries [1] to 3.']).text).toBe('Set max_retries [1] to 3.');
  });

  it('strips HTML tags', () => {
    expect(speak(['Hello <b>world</b>.']).text).toBe('Hello world.');
  });

  it('never holds an endless run without spaces forever', () => {
    const filter = new SpeechTextFilter();
    expect(filter.push('x'.repeat(301))).toBe('x'.repeat(301));
  });
});

/** Splits `source` into chunks of `size` characters, like arbitrary model token boundaries. */
function chunks(source: string, size: number): string[] {
  return source.match(new RegExp(`[\\s\\S]{1,${size}}`, 'gu'))!;
}

describe('SpeechTextFilter edge cases (verifier)', () => {
  it('says the same thing however markdown is split across deltas', () => {
    const sources = [
      'Here is **formatted** text:\n\n- first, a list item\n- then a [link](https://example.com)\n\nand `code` should not be read out as symbols.',
      '## Steps\n1. Open the app\n2. Tap **Call**\n\n```js\nconst a = 1;\n```\nDone! See ![the logo](https://x.y/l.png) too.',
      'Use _this_ one, not ~~that~~ one. > not a quote\n> a quote',
    ];
    for (const source of sources) {
      const whole = speak([source]).text;
      for (let size = 1; size <= 9; size += 1) {
        expect({ size, text: speak(chunks(source, size)).text }).toEqual({ size, text: whole });
      }
    }
  });

  it('a complete link whose text has a space is not split when nothing follows it yet', () => {
    const filter = new SpeechTextFilter();
    const first = filter.push('See the [release notes](https://example.com/x)');
    const rest = filter.push('. Then retry. ') + filter.end();
    expect(first + rest).toBe('See the release notes. Then retry. ');
    expect(first).not.toContain('[');
  });

  it('whitespace-only and empty deltas produce nothing to speak', () => {
    expect(speak(['', '   ', '\n', '\t', '\n\n', '']).pieces.every((p) => p === '')).toBe(true);
    expect(speak(['```\n', 'only code\n', '```']).text).toBe('');
  });

  it('never splits a surrogate pair or combining sequence into separate releases', () => {
    const { pieces } = speak(['Cheers 🎉', '🎉 done ', 'café ', 'naïve ']);
    for (const piece of pieces) {
      expect(piece).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    }
    expect(pieces.join('')).toBe('Cheers 🎉🎉 done café naïve ');
  });

  it('a raw HTML link with a URL keeps its text and drops the tag', () => {
    expect(speak(['Read <a href="https://x.y/docs">the docs</a> now.']).text).toBe(
      'Read the docs now.',
    );
  });

  it('an HTML tag split at a space inside it is still not read aloud', () => {
    expect(speak(['Read <a ', 'class="x">the docs</a> now.']).text).toBe('Read the docs now.');
  });

  it('an autolink <https://…> is spoken as "link" without the angle bracket', () => {
    expect(speak(['See <https://example.com> now.']).text).toBe('See link now.');
  });

  it('CRLF line endings are treated like LF', () => {
    const lf = speak(['- first item\n- second item\nDone.']).text;
    expect(speak(['- first item\r\n- second item\r\nDone.']).text).toBe(lf);
  });
});
