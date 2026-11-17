import {
  VoiceProviderError,
  type TtsEvent,
  type TtsProvider,
  type TtsSession,
  type VoiceError,
} from './types';

export interface FailoverOptions {
  onFailover(reason: string): void;
  /**
   * Whether a primary failure moves the call to the backup; every failure does when absent. A
   * person's own key keeps its refusals (`auth_failed`), so the phone can say the key was refused.
   */
  failsOver?(error: VoiceError): boolean;
}

/**
 * An answer the provider refused because it cannot find the voice (404): every later answer would
 * fail the same way, so the call moves to the backup instead of going silent.
 */
function voiceNotFound(error: VoiceError): boolean {
  return error.providerStatus === 404;
}

/** One call's TTS provider. A failed primary session is never reopened. */
export function createFailoverTts(
  primary: TtsProvider,
  backup: TtsProvider,
  options: FailoverOptions,
): TtsProvider {
  let switched = false;
  const failsOver = (error: VoiceError) => options.failsOver?.(error) ?? true;
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
      const end = (event: Extract<TtsEvent, { type: 'error' }>) => {
        failed = true;
        onEvent(event);
        void session?.close().catch(() => undefined);
      };
      try {
        session = await provider.open((event: TtsEvent) => {
          if (failed) return;
          const onPrimary = provider === primary;
          if (event.type === 'error') {
            if (!onPrimary || !failsOver(event.error)) return end(event);
            switchToBackup(event.error.code);
            // Recoverable: the pipeline reconnects, and the reconnect opens the backup.
            return end({ ...event, error: { ...event.error, recoverable: true } });
          }
          if (
            onPrimary &&
            event.type === 'generation_error' &&
            voiceNotFound(event.error) &&
            failsOver(event.error)
          ) {
            switchToBackup('voice_not_found');
            return end({ type: 'error', generationId: event.generationId, error: event.error });
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
        const reason: VoiceError =
          error instanceof VoiceProviderError
            ? error.error
            : { code: 'connection_lost', recoverable: true };
        if (!failsOver(reason)) throw error;
        switchToBackup(reason.code);
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
