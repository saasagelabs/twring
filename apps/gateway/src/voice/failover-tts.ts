import { VoiceProviderError, type TtsEvent, type TtsProvider, type TtsSession } from './types';

/** One call's TTS provider. A failed primary session is never reopened. */
export function createFailoverTts(
  primary: TtsProvider,
  backup: TtsProvider,
  options: { onFailover(reason: string): void },
): TtsProvider {
  let switched = false;
  const switchToBackup = (reason: string): void => {
    if (switched) return;
    switched = true;
    options.onFailover(reason);
  };

  return {
    get name() {
      return switched ? `${primary.name}→${backup.name}` : primary.name;
    },
    async open(onEvent, signal) {
      const provider = switched ? backup : primary;
      let session: TtsSession | undefined;
      let failed = false;
      try {
        session = await provider.open((event: TtsEvent) => {
          if (failed) return;
          if (event.type === 'error') {
            failed = true;
            if (provider === primary) {
              switchToBackup(event.error.code);
              onEvent({ ...event, error: { ...event.error, recoverable: true } });
            } else {
              onEvent(event);
            }
            void session?.close().catch(() => undefined);
            return;
          }
          onEvent(event);
        }, signal);
        if (signal.aborted) {
          await session.close();
          throw signal.reason;
        }
        return session;
      } catch (error) {
        if (session !== undefined) throw error;
        if (provider === backup || signal.aborted) throw error;
        switchToBackup(error instanceof VoiceProviderError ? error.error.code : 'connection_lost');
        const backupSession = await backup.open(onEvent, signal);
        if (signal.aborted) {
          await backupSession.close();
          throw signal.reason;
        }
        return backupSession;
      }
    },
  };
}
