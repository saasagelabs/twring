import type { CallState } from '@twring/contracts';

import type { CallTranscriptResult } from '@/api/client';
import type { RingSettings } from '@/ring/protocol';

/** Offer "Transcripts in chat" after a call that connected, to an agent whose chat is not private. */
export function canOfferTranscript(input: {
  call: CallState;
  connectedAt: number | undefined;
  agentKnown: boolean;
  chatsAvailable: boolean;
  privateChat: boolean;
}): boolean {
  const { call, connectedAt, agentKnown, chatsAvailable, privateChat } = input;
  return (
    (call.status === 'ENDED' || call.status === 'FAILED') &&
    call.callId !== undefined &&
    connectedAt !== undefined &&
    agentKnown &&
    chatsAvailable &&
    !privateChat
  );
}

/**
 * Where the row stands. `on_at_end`: the setting was already on, so the server put this call's
 * transcript on its card. `private`: the server says the chat is private; the row hides.
 */
export type TranscriptState =
  | { kind: 'loading' }
  | { kind: 'off' }
  | { kind: 'on_at_end' }
  | { kind: 'saving'; on: boolean }
  | { kind: 'save_failed'; on: boolean; error: unknown }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'gone' }
  | { kind: 'send_failed'; error: unknown }
  | { kind: 'private' };

/** What the switch shows: a failed save shows the value it went back to. */
export function transcriptSwitchOn(state: TranscriptState): boolean {
  switch (state.kind) {
    case 'loading':
    case 'off':
    case 'private':
      return false;
    case 'saving':
      return state.on;
    case 'save_failed':
      return !state.on;
    case 'on_at_end':
    case 'sending':
    case 'sent':
    case 'gone':
    case 'send_failed':
      return true;
  }
}

/**
 * Right after hang-up the server may still be closing the call, so its words are not held yet: a
 * "not found" this soon after the call ended is tried again after these waits.
 */
export const TRANSCRIPT_RETRY_MS = [1500, 3000, 5000] as const;
/** How long after the call ended a "not found" may still mean "not there yet". */
export const TRANSCRIPT_SETTLE_MS = 30_000;

export interface TranscriptDeps {
  callId: string;
  /** When the call ended (the app's clock), to tell "not yet" from "gone". */
  endedAt?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  ringSettings(): Promise<RingSettings>;
  updateRingSettings(settings: RingSettings): Promise<RingSettings>;
  sendCallTranscript(callId: string): Promise<CallTranscriptResult>;
}

/**
 * The call-ended row's logic, apart from React. Turning it on saves the setting (shown at once,
 * put back if the save fails) and then sends this call's transcript; turning it off saves off,
 * and later calls send none. A newer action wins over the answer of an older one.
 */
export function createTranscriptToChat(deps: TranscriptDeps, onChange: () => void) {
  let state: TranscriptState = { kind: 'loading' };
  let settings: RingSettings | undefined;
  let action = 0;
  const set = (next: TranscriptState) => {
    state = next;
    onChange();
  };

  async function send(id: number) {
    set({ kind: 'sending' });
    try {
      let result = await deps.sendCallTranscript(deps.callId);
      const now = deps.now ?? Date.now;
      const wait = deps.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
      for (const ms of TRANSCRIPT_RETRY_MS) {
        if (result !== 'gone' || id !== action) break;
        if (deps.endedAt === undefined || now() - deps.endedAt > TRANSCRIPT_SETTLE_MS) break;
        await wait(ms);
        if (id !== action) return;
        result = await deps.sendCallTranscript(deps.callId);
      }
      if (id !== action) return;
      set({ kind: result === 'sent' ? 'sent' : result === 'gone' ? 'gone' : 'private' });
    } catch (error) {
      if (id === action) set({ kind: 'send_failed', error });
    }
  }

  async function setOn(on: boolean) {
    const id = ++action;
    set({ kind: 'saving', on });
    try {
      const current = settings ?? (await deps.ringSettings());
      const saved = await deps.updateRingSettings({ ...current, call_transcripts: on });
      settings = saved;
      if (id !== action) return;
      if (on) await send(id);
      else set({ kind: 'off' });
    } catch (error) {
      if (id === action) set({ kind: 'save_failed', on, error });
    }
  }

  return {
    getState: (): TranscriptState => state,
    async load() {
      const id = action;
      try {
        settings = await deps.ringSettings();
        if (id === action) set({ kind: settings.call_transcripts === true ? 'on_at_end' : 'off' });
      } catch {
        // Unknown: offer the switch; turning it on reads the settings again.
        if (id === action) set({ kind: 'off' });
      }
    },
    setOn,
    retry() {
      if (state.kind === 'save_failed') return setOn(state.on);
      if (state.kind === 'send_failed') return send(++action);
      return Promise.resolve();
    },
  };
}
export type TranscriptToChatModel = ReturnType<typeof createTranscriptToChat>;
