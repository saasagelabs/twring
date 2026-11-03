import { useSyncExternalStore } from 'react';

import { mobileEnv } from '../config/env';
import { profileStore, type ServerProfile } from './profiles';

/** The active server's address: a self-hosted one's, or the build's API_BASE_URL for hosted. */
export function activeServerUrl(): string {
  const active = profileStore.active();
  if (active.kind === 'selfhost') return active.address;
  return mobileEnv.ok ? mobileEnv.env.API_BASE_URL : '';
}

/**
 * Where agents download the connector and the skill: always Twring's own address (the build's
 * API_BASE_URL). A self-hosted server does not serve these downloads.
 */
export function downloadsServerUrl(): string {
  return mobileEnv.ok ? mobileEnv.env.API_BASE_URL : '';
}

/** Runs the listener when the active server (or its saved profile) changes. Returns an unsubscribe. */
export function onActiveServerChanged(listener: () => void): () => void {
  return profileStore.subscribe(listener);
}

export function useActiveServer(): ServerProfile {
  return useSyncExternalStore(
    (listener) => profileStore.subscribe(listener),
    () => profileStore.active(),
  );
}
