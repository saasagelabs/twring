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
  set: (language: SpeakerLanguage) => set({ status: 'loaded', language }),
  /** Asks the server once; `force` asks again (Settings opening). */
  load(force = false): Promise<void> {
    if (loading !== undefined && !force) return loading;
    if (state.status !== 'unknown' && !force) return Promise.resolve();
    const api = twringApi();
    if (api?.getLanguage === undefined) {
      set({ status: 'unavailable' });
      return Promise.resolve();
    }
    loading = api.getLanguage().then(
      (language) =>
        set(language === undefined ? { status: 'unavailable' } : { status: 'loaded', language }),
      () => {
        // A failure keeps a language already known; otherwise the row stays hidden.
        if (state.status !== 'loaded') set({ status: 'unavailable' });
      },
    );
    void loading.finally(() => {
      loading = undefined;
    });
    return loading;
  },
  reset: () => set({ status: 'unknown' }),
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
