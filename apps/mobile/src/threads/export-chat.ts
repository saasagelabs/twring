import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

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
  options: { signal: AbortSignal; onProgress: (count: number) => void },
): Promise<{ capped: boolean }> {
  if (!(await Sharing.isAvailableAsync())) throw new SharingUnavailableError();
  const { messages, capped } = await collectThread(api, agent.id, options);
  const now = new Date();
  const markdown = renderChatMarkdown(messages, { agentName: agent.name, exportedAt: now, capped });
  if (options.signal.aborted) return { capped };
  const file = new File(Paths.cache, exportFileName(agent.name, now));
  try {
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
