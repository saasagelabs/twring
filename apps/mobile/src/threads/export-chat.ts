import type { ThreadMessage } from '@twring/contracts';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { CHAT_EXPORT_FOLDER } from './sealed-file-cache';
import type { OpenedMessage } from '../e2e/sealed-thread';
import {
  collectThread,
  exportFileName,
  renderChatMarkdown,
  type ExportPageSource,
} from './export-markdown';

export class SharingUnavailableError extends Error {
  constructor() {
    super('Sharing is not available on this device');
    this.name = 'SharingUnavailableError';
  }
}

/**
 * Pages the whole chat, writes it as Markdown to the cache and opens the share sheet. The temp
 * file is deleted once the sheet closes or anything fails. Dismissing the sheet is not an error.
 */
export async function exportChat(
  api: ExportPageSource,
  agent: { id: string; name: string },
  options: {
    signal: AbortSignal;
    onProgress: (count: number) => void;
    /** A private chat: opens its sealed messages on this phone (never a server export). */
    open?: (messages: ThreadMessage[]) => Promise<OpenedMessage[] | undefined>;
  },
): Promise<{ capped: boolean }> {
  if (!(await Sharing.isAvailableAsync())) throw new SharingUnavailableError();
  const { messages, capped } = await collectThread(api, agent.id, options);
  const now = new Date();
  const open = messages.some((message) => message.kind === 'sealed') ? options.open : undefined;
  const opened = open ? await open(messages).catch(() => undefined) : undefined;
  if (options.signal.aborted) return { capped };
  const markdown = renderChatMarkdown(messages, {
    agentName: agent.name,
    exportedAt: now,
    capped,
    ...(open && {
      opened: new Map((opened ?? []).map((message) => [message.id, message])),
    }),
  });
  if (options.signal.aborted) return { capped };
  // Its own folder: the start-up sweep, sign-out and removing this phone delete what a killed
  // share sheet leaves behind.
  const folder = new Directory(Paths.cache, CHAT_EXPORT_FOLDER);
  const file = new File(folder, exportFileName(agent.name, now));
  try {
    if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
    if (file.exists) file.delete();
    file.write(markdown);
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/markdown',
      UTI: 'net.daringfireball.markdown',
      dialogTitle: `Chat with ${agent.name}`,
    });
  } finally {
    try {
      file.delete();
    } catch {
      /* already gone */
    }
  }
  return { capped };
}
