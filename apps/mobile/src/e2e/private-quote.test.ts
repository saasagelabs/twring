import { MAX_QUOTE_CHARS } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { phoneQuote } from './private-quote';
import type { OpenedMessage } from './sealed-thread';

const id = 'msg_' + 'a'.repeat(20);
const ok = (text: string, author: 'user' | 'agent' = 'agent'): OpenedMessage => ({
  id,
  author,
  state: 'ok',
  text,
});

describe('reply quotes built on the phone (Task 22)', () => {
  it('cuts to 280 characters plus an ellipsis, as the server does', () => {
    const quote = phoneQuote(ok('x'.repeat(400)))!;
    expect(quote.text).toHaveLength(MAX_QUOTE_CHARS + 1);
    expect(quote.text.endsWith('…')).toBe(true);
    expect(quote).toMatchObject({ message_id: id, from: 'agent' });
  });

  it('keeps a short quote whole, on one line', () => {
    expect(phoneQuote(ok('  Ship\n\n it?  ', 'user'))).toEqual({
      message_id: id,
      text: 'Ship it?',
      from: 'owner',
    });
  });

  it('never cuts a character in half', () => {
    const text = 'x'.repeat(MAX_QUOTE_CHARS - 1) + '\u{1F600}' + 'y';
    expect(phoneQuote(ok(text))!.text).toBe('x'.repeat(MAX_QUOTE_CHARS - 1) + '…');
  });

  it('quotes file names when there is no text', () => {
    const files = [{ file_id: 'f', key: 'k', name: 'plan.pdf', mime: 'application/pdf', size: 1 }];
    expect(phoneQuote({ ...ok(''), files } as OpenedMessage)!.text).toBe('[plan.pdf]');
  });

  it('a reply to a message that could not be opened has no quote', () => {
    expect(phoneQuote({ id, author: 'agent', state: 'couldnt_open' })).toBeUndefined();
    expect(phoneQuote({ id, state: 'missing_before', missing: 2 })).toBeUndefined();
    expect(phoneQuote(undefined)).toBeUndefined();
  });
});
