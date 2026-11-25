import { MAX_QUOTE_CHARS, type SealedPayload } from '@twring/contracts';

import type { OpenedMessage } from './sealed-thread';

export type PhoneQuote = NonNullable<SealedPayload['quote']>;

/**
 * A private reply's quote, built on the phone and sealed with the reply (the server never sees
 * it). Same cut rule as the server's `quoteOf` (apps/gateway/src/threads/quote.ts): plain text on
 * one line, file names when there is no text, cut to MAX_QUOTE_CHARS plus an ellipsis without
 * splitting a character. A message that could not be opened has no quote.
 */
export function phoneQuote(target: OpenedMessage | undefined): PhoneQuote | undefined {
  if (target === undefined || target.state !== 'ok') return undefined;
  const files = (target.files ?? []).map((file) => `[${file.name}]`).join(' ');
  const flat = (target.text.trim() || files).replace(/\s+/gu, ' ').trim();
  let text = flat;
  if (flat.length > MAX_QUOTE_CHARS) {
    let end = MAX_QUOTE_CHARS;
    const last = flat.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    text = `${flat.slice(0, end).trimEnd()}…`;
  }
  return { message_id: target.id, text, from: target.author === 'agent' ? 'agent' : 'owner' };
}
