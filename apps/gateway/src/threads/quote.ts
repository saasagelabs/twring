import { MAX_QUOTE_CHARS, type ThreadMessage } from '@twring/contracts';

export type Quote = NonNullable<Extract<ThreadMessage, { kind: 'user_text' }>['quote']>;

/**
 * The quote a reply keeps of the message it answers: the text as plain text (markdown is not
 * rendered), on one line, cut to MAX_QUOTE_CHARS. A message with only files quotes their names.
 * Undefined for a message that cannot be answered (a call, ring, approval or notice).
 */
export function quoteOf(message: ThreadMessage): Quote | undefined {
  if (message.kind !== 'user_text' && message.kind !== 'agent_text') return undefined;
  const files = (message.attachments ?? []).map((file) => `[${file.name}]`).join(' ');
  const flat = (message.text.trim() || files).replace(/\s+/gu, ' ').trim();
  let text = flat;
  if (flat.length > MAX_QUOTE_CHARS) {
    let end = MAX_QUOTE_CHARS;
    const last = flat.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    text = `${flat.slice(0, end).trimEnd()}…`;
  }
  return { text, from: message.kind === 'agent_text' ? 'agent' : 'owner' };
}

/** The text an agent receives for a reply: the quote in plain words, a blank line, then the text. */
export function withQuote(
  message: Extract<ThreadMessage, { kind: 'user_text' }>,
  text: string,
): string {
  if (!message.quote) return text;
  const whose = message.quote.from === 'agent' ? 'your' : 'my';
  return `Replying to ${whose} earlier message: "${message.quote.text}"\n\n${text}`;
}
