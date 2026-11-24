import type { ThreadMessage } from '@twring/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';

import { chatController } from './chats';
import { exportChat, SharingUnavailableError } from './export-chat';
import { EXPORT_MESSAGE_CAP } from './export-markdown';

const SHARING_UNAVAILABLE: ErrorCopy = {
  message: "This phone can't open the share sheet, so the chat can't be exported here.",
  retryable: false,
};

export interface ChatExport {
  /** Messages gathered so far while exporting; undefined when idle. */
  progress: number | undefined;
  error: ErrorCopy | undefined;
  /** Set when the cap cut the export short. */
  note: string | undefined;
  start: () => void;
  cancel: () => void;
}

/** "Export chat" on the agent screen: pages the chat, shares a Markdown file, cancellable. */
export function useChatExport(agent: { id: string; name: string } | undefined): ChatExport {
  const [progress, setProgress] = useState<number | undefined>();
  const [error, setError] = useState<ErrorCopy | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const controller = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => controller.current?.abort(), []);

  const start = useCallback(() => {
    const api = twringApi();
    if (agent === undefined || api === undefined || controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setError(undefined);
    setNote(undefined);
    setProgress(0);
    // A private chat is opened on this phone; there is no server export (Task 23).
    const open = (messages: ThreadMessage[]) =>
      chatController()?.openForExport(agent.id, messages) ?? Promise.resolve(undefined);
    exportChat(api, agent, { signal: current.signal, onProgress: setProgress, open })
      .then(({ capped }) => {
        if (capped && !current.signal.aborted)
          setNote(
            `This chat is very long, so only the first ${EXPORT_MESSAGE_CAP.toLocaleString('en-US')} messages were exported.`,
          );
      })
      .catch((caught: unknown) => {
        if (current.signal.aborted) return;
        setError(
          caught instanceof SharingUnavailableError ? SHARING_UNAVAILABLE : apiErrorCopy(caught),
        );
      })
      .finally(() => {
        if (controller.current === current) controller.current = undefined;
        if (!current.signal.aborted) setProgress(undefined);
      });
  }, [agent]);

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = undefined;
    setProgress(undefined);
  }, []);

  return { progress, error, note, start, cancel };
}
