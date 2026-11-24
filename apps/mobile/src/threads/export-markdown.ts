import type { ThreadMessage } from '@twring/contracts';

import type { OpenedMessage } from '../e2e/sealed-thread';

/** The most messages one export holds; the server keeps fewer per thread today. */
export const EXPORT_MESSAGE_CAP = 20_000;
const PAGE_SIZE = 100;

export interface ExportPageSource {
  listMessages(
    agentId: string,
    options: { afterRev: number; limit: number },
    signal?: AbortSignal,
  ): Promise<{ messages: ThreadMessage[]; hasMore: boolean }>;
}

export interface CollectedThread {
  messages: ThreadMessage[];
  /** True when the cap stopped paging before the end of the chat. */
  capped: boolean;
}

function abortError(): Error {
  const error = new Error('Export cancelled');
  error.name = 'AbortError';
  return error;
}

/**
 * Pages through the whole thread by revision (the same cursor catch-up uses), oldest first.
 * Throws an `AbortError` as soon as `signal` aborts; stops at the end or at `cap` messages.
 */
export async function collectThread(
  api: ExportPageSource,
  agentId: string,
  options: { signal?: AbortSignal; cap?: number; onProgress?: (count: number) => void } = {},
): Promise<CollectedThread> {
  const cap = options.cap ?? EXPORT_MESSAGE_CAP;
  const byId = new Map<string, ThreadMessage>();
  let cursor = 0;
  let capped = false;
  for (;;) {
    if (options.signal?.aborted) throw abortError();
    const page = await api.listMessages(
      agentId,
      { afterRev: cursor, limit: PAGE_SIZE },
      options.signal,
    );
    if (options.signal?.aborted) throw abortError();
    for (const message of page.messages) {
      if (!byId.has(message.id) && byId.size >= cap) {
        capped = true;
        break;
      }
      byId.set(message.id, message);
    }
    options.onProgress?.(byId.size);
    if (capped || !page.messages.length || !page.hasMore) break;
    const next = Math.max(cursor, ...page.messages.map((message) => message.rev));
    if (next === cursor) break;
    cursor = next;
  }
  const messages = [...byId.values()].sort((a, b) => a.seq - b.seq);
  return { messages, capped };
}

/** Backslash-escapes characters that would turn a name into Markdown syntax. */
export function escapeInline(text: string): string {
  return text.replace(/[\\`*_[\]#<>|~]/g, (character) => `\\${character}`).replace(/\s+/g, ' ');
}

/**
 * A message body as a block quote: every line is prefixed, so headings, fences or rules inside a
 * message stay inside that message and cannot break the export's structure.
 */
function quote(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line.length ? `> ${line}` : '>'))
    .join('\n');
}

function localStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'time unknown';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function minutes(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  return `${Math.round(seconds / 60)} min`;
}

function attachmentLine(message: ThreadMessage): string | undefined {
  if (message.kind !== 'user_text' && message.kind !== 'agent_text') return undefined;
  if (!message.attachments?.length) return undefined;
  return `_Files: ${message.attachments.map((file) => escapeInline(file.name)).join(', ')}_`;
}

/** A private message the phone could not open, in an export (Task 23). */
export const COULDNT_OPEN_EXPORT = "(Couldn't open this message)";

function body(message: ThreadMessage, opened?: ReadonlyMap<string, OpenedMessage>): string {
  switch (message.kind) {
    case 'user_text':
      if (message.voice) return quote(`Voice note (transcript): ${message.text}`);
      return message.text.length ? quote(message.text) : '';
    case 'agent_text':
      return message.text.length ? quote(message.text) : '';
    case 'call':
      return `_Call, ${minutes(message.duration_s)}, ${message.outcome}_`;
    case 'ring':
      return `_Rang your phone: ${escapeInline(message.reason)} (${message.outcome})_`;
    case 'approval':
      return `_Asked to approve: ${escapeInline(message.title)} (${message.status})_`;
    case 'notice':
      return '_New conversation started_';
    case 'sealed': {
      // Opened on this phone only; the server never sees the text.
      const found = opened?.get(message.id);
      if (found?.state !== 'ok') return COULDNT_OPEN_EXPORT;
      return found.text.length ? quote(found.text) : '';
    }
  }
}

function speaker(message: ThreadMessage, agentName: string): string {
  if (message.kind === 'sealed') return message.author === 'user' ? 'You' : agentName;
  return message.kind === 'user_text' || message.kind === 'call' ? 'You' : agentName;
}

export interface MarkdownOptions {
  agentName: string;
  exportedAt: Date;
  capped?: boolean;
  /** Formats a message time; defaults to the phone's local date and time. */
  formatTime?: (iso: string) => string;
  /** A private chat's messages as opened on this phone, by message id. */
  opened?: ReadonlyMap<string, OpenedMessage>;
}

export function renderChatMarkdown(messages: ThreadMessage[], options: MarkdownOptions): string {
  const name = escapeInline(options.agentName.trim() || 'Agent');
  const stamp = options.formatTime ?? localStamp;
  const lines = [`# Chat with ${name}`, '', `Exported ${localDate(options.exportedAt)}`, ''];
  if (options.capped) {
    lines.push(
      `_Only the first ${messages.length.toLocaleString('en-US')} messages are included._`,
    );
    lines.push('');
  }
  if (!messages.length) {
    lines.push('No messages yet.', '');
    return lines.join('\n');
  }
  for (const message of messages) {
    lines.push(`**${speaker(message, name)}** (${stamp(message.created_at)}):`, '');
    const text = body(message, options.opened);
    if (text) lines.push(text, '');
    const files = attachmentLine(message);
    if (files) lines.push(files, '');
  }
  return lines.join('\n');
}

/** `<agent>-chat-<yyyy-mm-dd>.md`, with the agent name reduced to safe file name characters. */
export function exportFileName(agentName: string, date: Date): string {
  const slug =
    agentName
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'agent';
  return `${slug}-chat-${localDate(date)}.md`;
}
