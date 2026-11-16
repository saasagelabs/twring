import type { SpeakerLanguage } from '@twring/contracts';
import { useEffect, useSyncExternalStore } from 'react';

import { twringApi } from '@/api';
import { onActiveServerChanged } from '@/servers/active';

/** `unavailable`: the server has no language setting (older or your own server), or it failed. */
export type LanguageState =
  | { status: 'unknown' }
  | { status: 'unavailable' }
  | { status: 'loaded'; language: SpeakerLanguage };

let state: LanguageState = { status: 'unknown' };
let loading: Promise<void> | undefined;
/** Bumped on a server change or a save: answers to reads asked before it are stale. */
let generation = 0;
const listeners = new Set<() => void>();

function set(next: LanguageState) {
  state = next;
  listeners.forEach((listener) => listener());
}

/** Shared by Settings and the voice pickers, so a change shows everywhere without a restart. */
export const languageStore = {
  get: (): LanguageState => state,
  subscribe(this: void, listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Saves on the server, then shows it everywhere, unless the server changed meanwhile. */
  async save(language: SpeakerLanguage): Promise<SpeakerLanguage> {
    const api = twringApi();
    if (api?.setLanguage === undefined) throw new Error('language setting unavailable');
    // Reads asked before this save are older than it: they must not overwrite it.
    generation += 1;
    loading = undefined;
    const asked = generation;
    const saved = await api.setLanguage(language);
    if (asked === generation) set({ status: 'loaded', language: saved });
    return saved;
  },
  /** Asks the server once; `force` asks again (Settings opening). */
  load(force = false): Promise<void> {
    if (loading !== undefined && !force) return loading;
    if (state.status !== 'unknown' && !force) return Promise.resolve();
    const api = twringApi();
    if (api?.getLanguage === undefined) {
      set({ status: 'unavailable' });
      return Promise.resolve();
    }
    const asked = generation;
    const request = api.getLanguage().then(
      (language) => {
        if (asked !== generation) return;
        set(language === undefined ? { status: 'unavailable' } : { status: 'loaded', language });
      },
      () => {
        // A failure keeps a language already known; otherwise the row stays hidden.
        if (asked === generation && state.status !== 'loaded') set({ status: 'unavailable' });
      },
    );
    loading = request;
    void request.finally(() => {
      if (loading === request) loading = undefined;
    });
    return request;
  },
  /** Forgets the language and asks the (new) active server; older answers are dropped. */
  reset() {
    generation += 1;
    loading = undefined;
    set({ status: 'unknown' });
    void languageStore.load();
  },
};

export function useLanguageState(): LanguageState {
  const current = useSyncExternalStore(languageStore.subscribe, languageStore.get);
  useEffect(() => {
    void languageStore.load();
  }, []);
  return current;
}

/** The person's language for voice lists; English until the server says otherwise. */
export function useSpeakerLanguage(): SpeakerLanguage {
  const current = useLanguageState();
  return current.status === 'loaded' ? current.language : 'en';
}

/** The same outside React; English until known. */
export function currentLanguage(): SpeakerLanguage {
  return state.status === 'loaded' ? state.language : 'en';
}

// Another server keeps its own setting.
onActiveServerChanged(() => languageStore.reset());
