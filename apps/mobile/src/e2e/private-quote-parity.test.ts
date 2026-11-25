import { MAX_QUOTE_CHARS, type ThreadMessage } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

// The gateway's own rule, imported as is, so the two copies cannot drift unnoticed.
import { quoteOf } from '../../../gateway/src/threads/quote';
import { phoneQuote } from './private-quote';

const N = MAX_QUOTE_CHARS;
const cases: [string, string][] = [
  ['exactly the limit', 'a'.repeat(N)],
  ['one over the limit', 'a'.repeat(N + 1)],
  ['emoji straddling the cut', 'a'.repeat(N - 1) + '\u{1F600}tail'],
  ['emoji ending exactly at the cut', 'a'.repeat(N - 2) + '\u{1F600}tail'],
  ['combining mark at the cut', 'a'.repeat(N - 1) + 'émore'],
  ['flag pair at the cut', 'a'.repeat(N - 3) + '\u{1F1EE}\u{1F1F3}xx'],
  ['spaces at the cut', 'a'.repeat(N - 3) + '      end'],
  ['trailing whitespace', 'hello   \n\t '],
  ['newlines inside', 'one\n\ntwo\r\nthree'],
  ['only whitespace', ' \n\t '],
  ['non-breaking and ideographic spaces', 'a b　c'],
  ['long with newlines', 'line\n'.repeat(100)],
];

describe("the phone's quote cut matches the gateway's (Task 22)", () => {
  for (const [name, text] of cases)
    it(name, () => {
      const server = quoteOf({ kind: 'agent_text', text } as ThreadMessage);
      const phone = phoneQuote({ id: 'm', author: 'agent', state: 'ok', text });
      expect(phone?.text).toBe(server?.text);
      expect(phone?.from).toBe(server?.from);
    });

  it('file names when there is no text', () => {
    const files = [
      { file_id: 'f1', key: 'k', name: 'a.pdf', mime: 'application/pdf', size: 1 },
      { file_id: 'f2', key: 'k', name: 'b c.png', mime: 'image/png', size: 1 },
    ];
    const server = quoteOf({
      kind: 'user_text',
      text: ' ',
      attachments: files,
    } as unknown as ThreadMessage);
    const phone = phoneQuote({ id: 'm', author: 'user', state: 'ok', text: ' ', files } as never);
    expect(phone?.text).toBe(server?.text);
    expect(phone?.from).toBe('owner');
  });
});
