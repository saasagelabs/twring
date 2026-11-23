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
    expect(pieces.join('')).toBe('Cheers done café naïve ');
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

describe('SpeechTextFilter code-heavy answers', () => {
  const note = "I've left the code on screen.";
  function noted(deltas: string[]): string {
    const filter = new SpeechTextFilter({ codeNote: note });
    return deltas.map((delta) => filter.push(delta)).join('') + filter.end();
  }

  it('says the note once in place of the first code block, in any split', () => {
    const source = 'Run this:\n```bash\nrm -rf build\n```\nThen\n```\npnpm i\n```\nretry.';
    const expected = `Run this: ${note} Then. retry.`;
    for (let size = 1; size <= 9; size += 1) expect(noted(chunks(source, size))).toBe(expected);
  });

  it('ends the sentence before the note', () => {
    expect(noted(['Here it is\n```\nx\n```\n'])).toBe(`Here it is. ${note} `);
  });

  it('a reply of only code still says the note', () => {
    expect(noted(['```ts\nconst a = 1;\n```']).trim()).toBe(note);
  });

  it('keeps short inline code and drops long inline code, in any split', () => {
    const long = '`const handler = createHandler({ retries: 3, backoff: 250 })`';
    const source = `Run \`npm test\` then ${long} again.`;
    for (let size = 1; size <= 9; size += 1)
      expect(speak(chunks(source, size)).text).toBe('Run npm test then again.');
  });

  it('reads a file path as its file name', () => {
    expect(speak(['Open src/app/call.tsx now.']).text).toBe('Open call.tsx now.');
    expect(speak(['See C:\\Users\\x\\notes.md please']).text).toBe('See notes.md please');
    expect(speak(['Look in apps/gateway/ first']).text).toBe('Look in gateway first');
    expect(speak(['and/or stays, 1/2/2024 stays']).text).toBe('and/or stays, 1/2/2024 stays');
  });

  it('drops hashes, git shas and UUIDs, but not numbers or words', () => {
    expect(speak(['Commit 3f9a2b7c1d4e5f60718293a4b5c6d7e8f9012345 landed']).text).toBe(
      'Commit landed',
    );
    expect(speak(['id 123e4567-e89b-12d3-a456-426614174000 ok']).text).toBe('id ok');
    expect(speak(['call 1234567890123 or deadbeefcafe']).text).toBe(
      'call 1234567890123 or deadbeefcafe',
    );
  });

  it('stays fast on 100k characters of awkward input', () => {
    const inputs = [
      'a/'.repeat(50_000),
      `${'a'.repeat(100_000)}/b`,
      `${'0a'.repeat(50_000)}g`,
      '`'.repeat(100_000),
      `\`${'x '.repeat(50_000)}`,
      'ab/cd '.repeat(20_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      noted(chunks(input, 997));
      noted([input]);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });
});

describe('SpeechTextFilter tables, emoji, separators and CJK', () => {
  const every = (source: string, max = 9): string[] => {
    const out: string[] = [];
    for (let size = 1; size <= max; size += 1) out.push(speak(chunks(source, size)).text);
    return out;
  };

  it('reads a table row by row as plain cells, without pipes or dashes, in any split', () => {
    const source =
      'Prices:\n| Plan | Cost |\n|------|:----:|\n| Free | 0 |\n| Pro | 10 |\nThat is all.';
    for (const text of every(source, 12))
      expect(text).toBe('Prices: Plan, Cost. Free, 0. Pro, 10. That is all.');
  });

  it('holds a table row split mid-cell until the row ends', () => {
    const filter = new SpeechTextFilter();
    expect(filter.push('| Name | Ag')).toBe('');
    expect(filter.push('e |\n|--')).toBe('Name, Age. ');
    expect(filter.push('-|---|\n')).toBe('');
  });

  it('drops separator lines', () => {
    for (const sep of ['---', '***', '===', '___', '- - -', '* * *'])
      for (const text of every(`One\n${sep}\nTwo`)) expect(text).toBe('One. Two');
  });

  it('removes emoji, ZWJ families, flags, skin tones and keycaps, keeping text and CJK', () => {
    expect(speak(['Done ✅ ready 🚀!']).text).toBe('Done ready !');
    expect(speak(['Family 👨‍👩‍👧‍👦 here']).text).toBe('Family here');
    expect(speak(['From 🇯🇵 and 🏴󠁧󠁢󠁳󠁣󠁴󠁿 ok']).text).toBe('From and ok');
    expect(speak(['Wave 👋🏽 hi ❤️ 1️⃣']).text).toBe('Wave hi 1');
    expect(speak(['日本語 😀 テキスト']).text).toBe('日本語 テキスト');
  });

  it('never leaks part of an emoji split across deltas', () => {
    const source = 'Hi 👨‍👩‍👧 and 👋🏽 bye';
    for (let size = 1; size <= 6; size += 1) {
      const deltas = Array.from(
        source.matchAll(new RegExp(`[\\s\\S]{1,${size}}`, 'g')),
        (m) => m[0],
      );
      const { pieces, text } = speak(deltas);
      expect(text).toBe('Hi and bye');
      for (const piece of pieces) expect(piece).not.toMatch(/[\uD800-\uDFFF\u200D\uFE0F]/);
    }
  });

  it('strips mixed markdown in one reply', () => {
    expect(speak(['# Result 🎉\nnext']).text).toBe('Result. next');
    const source = '# 🎉 Result\n\n**Bold** and *it*\n---\n- item one\n| a | b |\n|---|---|\nend';
    for (const text of every(source)) expect(text).toBe('Result. Bold and it. item one. a, b. end');
  });

  it('releases Japanese sentence by sentence as it streams', () => {
    const filter = new SpeechTextFilter();
    expect(filter.push('こんにちは。今日は')).toBe('こんにちは。');
    expect(filter.push('いい天気ですね！明日')).toBe('今日はいい天気ですね！');
    expect(filter.push('は？「はい。」そ')).toBe('明日は？「はい。」');
    expect(filter.push('うです．次')).toBe('そうです．');
    expect(filter.end()).toBe('次');
  });

  it('keeps Japanese text whole in any split', () => {
    const source = '最初の文です。二番目！「引用？」\n三番目です。';
    for (const text of every(source))
      expect(text).toBe('最初の文です。二番目！「引用？」 三番目です。');
  });
});
