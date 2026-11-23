import { pipelineRetries, retriedFrom } from './tts-retry';
import {
  VoiceProviderError,
  type TtsEvent,
  type TtsProvider,
  type TtsSession,
  type VoiceError,
} from './types';

export interface FailoverOptions {
  /** An answer or the whole call moved to the backup; `reason` is a code, never text. */
  onFailover(reason: string): void;
  /** The primary spoke again after an answer had moved to the backup. */
  onRestored?(): void;
  /**
   * Whether a primary failure moves to the backup; every failure does when absent. A person's own
   * key keeps its refusals (`auth_failed`), so the phone can say the key was refused.
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

/**
 * Primary sessions dropped in a row with no answer finished between them, after which the call
 * moves to the backup for good (pipecat marks a TTS unusable after 3 silent contexts). Without it
 * a primary that drops on every answer is reopened all call long.
 */
const MAX_PRIMARY_DROPS = 3;

/** Answers remembered per session; older ones are long finished or cancelled. */
const TRACKED_ANSWERS = 16;

interface Answer {
  /** Every word sent so far, so the backup can speak the answer from its start. */
  text: string;
  flushed: boolean;
  /** Audio of it arrived: it stays where it is (a voice change mid-answer would be heard). */
  heard: boolean;
  onBackup: boolean;
}

/**
 * One call's TTS provider with a backup voice. Modelled on livekit/agents
 * `tts/fallback_adapter.py` and pipecat `pipeline/service_switcher.py`: the voice changes only
 * when the primary is unusable, never because of one hiccup.
 *
 * - A dropped primary session (any recoverable error, such as Deepgram's unconfirmed Interrupt)
 *   is reopened on the primary. The call moves to the backup for good only when the primary cannot
 *   be opened, an error no reconnect cures, or a voice the provider cannot find (404).
 * - One answer the primary cannot speak, and the pipeline will not retry (a 429, or the failed
 *   one-shot retry, or a retry that stayed silent), is spoken on the backup from its start, as
 *   fallback_adapter moves a segment that pushed no audio to the next TTS. The next answer is the
 *   primary's again. An answer that already made a sound is never moved.
 */
export function createFailoverTts(
  primary: TtsProvider,
  backup: TtsProvider,
  options: FailoverOptions,
): TtsProvider {
  let switched = false;
  let restorePending = false;
  let drops = 0;
  const failsOver = (error: VoiceError) => options.failsOver?.(error) ?? true;
  const switchToBackup = (reason: string): void => {
    if (switched) return;
    switched = true;
    options.onFailover(reason);
  };

  async function openBackupOnly(
    onEvent: (event: TtsEvent) => void,
    signal: AbortSignal,
  ): Promise<TtsSession> {
    let failed = false;
    const session: TtsSession = await backup.open((event) => {
      if (failed) return;
      onEvent(event);
      if (event.type !== 'error') return;
      // A broken session is closed here; the pipeline reconnects or ends the call.
      failed = true;
      void session.close().catch(() => undefined);
    }, signal);
    if (signal.aborted) {
      await session.close();
      throw signal.reason;
    }
    return session;
  }

  return {
    get name() {
      return switched ? `${primary.name}→${backup.name}` : primary.name;
    },
    async open(onEvent, signal) {
      if (switched) return openBackupOnly(onEvent, signal);
      const answers = new Map<string, Answer>();
      /** Answers moved to the backup; late primary events for them are dropped. */
      const moved = new Set<string>();
      let session: TtsSession | undefined;
      let failed = false;
      let closed = false;
      let backupReady: Promise<TtsSession> | undefined;
      let backupSeq = 0;

      const remember = (set: Set<string> | Map<string, Answer>) => {
        for (const old of set.keys()) {
          if (set.size <= TRACKED_ANSWERS) break;
          set.delete(old);
        }
      };

      const closeAll = (): Promise<void> => {
        closed = true;
        const ready = backupReady;
        backupReady = undefined;
        return Promise.all([
          session?.close(),
          ready?.then(
            (s) => s.close(),
            () => undefined,
          ),
        ]).then(() => undefined);
      };

      const end = (event: Extract<TtsEvent, { type: 'error' }>) => {
        failed = true;
        onEvent(event);
        void closeAll().catch(() => undefined);
      };

      const failOnBackup = (generationId: string, error: VoiceError) => {
        if (failed || closed || !answers.has(generationId)) return;
        answers.delete(generationId);
        onEvent({
          type: 'generation_error',
          generationId,
          error: { ...error, recoverable: false },
        });
      };

      const onBackupEvent = (seq: number) => (event: TtsEvent) => {
        if (failed || closed || seq !== backupSeq) return;
        if (event.type === 'error') {
          // The backup session is gone: its answers fail; a later answer opens it again.
          backupReady = undefined;
          backupSeq += 1;
          for (const [id, answer] of answers) {
            if (answer.onBackup) failOnBackup(id, event.error);
          }
          return;
        }
        const answer = answers.get(event.generationId);
        if (answer?.onBackup !== true) return;
        if (event.type === 'audio') answer.heard = true;
        else answers.delete(event.generationId);
        onEvent(event);
      };

      /** Runs `use` on the backup session, opened on first use; ops keep their order. */
      const withBackup = (
        use: (backupSession: TtsSession) => void,
        onFail?: (e: unknown) => void,
      ) => {
        if (backupReady === undefined) {
          const seq = (backupSeq += 1);
          const opening = backup.open(onBackupEvent(seq), signal).then(async (s) => {
            if (closed || seq !== backupSeq) {
              await s.close();
              throw new Error('closed');
            }
            return s;
          });
          backupReady = opening;
          opening.catch(() => {
            if (backupReady === opening) backupReady = undefined;
          });
        }
        backupReady.then(
          (s) => {
            if (!closed) use(s);
          },
          (error: unknown) => onFail?.(error),
        );
      };

      const moveToBackup = (generationId: string, reason: string): boolean => {
        const answer = answers.get(generationId);
        if (answer === undefined || answer.onBackup || answer.heard) return false;
        answer.onBackup = true;
        moved.add(generationId);
        remember(moved);
        session?.cancel(generationId);
        restorePending = true;
        options.onFailover(reason);
        // What was said so far is captured now; words that come later follow in order.
        const { text, flushed } = answer;
        withBackup(
          (s) => {
            if (answers.get(generationId) !== answer) return;
            if (text !== '') s.speak(generationId, text);
            if (flushed) s.flush(generationId);
          },
          (error) =>
            failOnBackup(
              generationId,
              error instanceof VoiceProviderError
                ? error.error
                : { code: 'connection_lost', recoverable: true },
            ),
        );
        return true;
      };

      const onPrimaryEvent = (event: TtsEvent) => {
        if (failed) return;
        if (event.type === 'error') {
          // Recoverable: the pipeline reconnects, and the reconnect opens the primary again,
          // unless it kept dropping with no answer finished.
          if (!failsOver(event.error)) return end(event);
          if (event.error.recoverable) {
            drops += 1;
            if (drops >= MAX_PRIMARY_DROPS) switchToBackup('primary_unstable');
            return end(event);
          }
          switchToBackup(event.error.code);
          return end({ ...event, error: { ...event.error, recoverable: true } });
        }
        const id = event.generationId;
        if (moved.has(id)) return;
        const answer = answers.get(id);
        switch (event.type) {
          case 'audio':
            if (answer !== undefined) answer.heard = true;
            if (restorePending) {
              restorePending = false;
              options.onRestored?.();
            }
            break;
          case 'done':
            drops = 0;
            answers.delete(id);
            break;
          case 'generation_error': {
            if (answer?.heard !== true && failsOver(event.error)) {
              if (voiceNotFound(event.error)) {
                switchToBackup('voice_not_found');
                return end({ type: 'error', generationId: id, error: event.error });
              }
              const reason = `generation_${event.error.providerStatus ?? event.error.code}`;
              if (!pipelineRetries(id, event.error) && moveToBackup(id, reason)) return;
            }
            answers.delete(id);
            break;
          }
        }
        onEvent(event);
      };

      try {
        session = await primary.open(onPrimaryEvent, signal);
        if (signal.aborted) {
          await session.close();
          throw signal.reason;
        }
      } catch (error) {
        if (session !== undefined || signal.aborted) throw error;
        const reason: VoiceError =
          error instanceof VoiceProviderError
            ? error.error
            : { code: 'connection_lost', recoverable: true };
        if (!failsOver(reason)) throw error;
        switchToBackup(reason.code);
        return openBackupOnly(onEvent, signal);
      }
      const primarySession = session;

      return {
        speak(generationId, text) {
          let answer = answers.get(generationId);
          if (answer === undefined) {
            // A retry of an answer the backup speaks stays on the backup.
            const from = retriedFrom(generationId);
            const onBackup = from !== undefined && moved.has(from);
            answer = { text: '', flushed: false, heard: false, onBackup };
            answers.set(generationId, answer);
            remember(answers);
            if (onBackup) {
              moved.add(generationId);
              remember(moved);
            }
          }
          answer.text += text;
          if (answer.onBackup) withBackup((s) => s.speak(generationId, text));
          else primarySession.speak(generationId, text);
        },
        flush(generationId) {
          const answer = answers.get(generationId);
          if (answer !== undefined) answer.flushed = true;
          if (answer?.onBackup === true) withBackup((s) => s.flush(generationId));
          else primarySession.flush(generationId);
        },
        cancel(generationId) {
          const answer = answers.get(generationId);
          answers.delete(generationId);
          if (answer?.onBackup !== true) primarySession.cancel(generationId);
          else if (backupReady !== undefined) withBackup((s) => s.cancel(generationId));
        },
        stalled(generationId) {
          const answer = answers.get(generationId);
          if (answer === undefined || answer.onBackup || answer.heard) return false;
          const error: VoiceError = { code: 'provider_error', recoverable: true };
          if (pipelineRetries(generationId, error) || !failsOver(error)) return false;
          return moveToBackup(generationId, 'stalled');
        },
        close: closeAll,
      };
    },
  };
}
