import type { ApiAuth, AuthState } from '../auth/controller';

import { profileStore, type ProfileStore } from './profiles';

/** How long the splash waits for the saved servers before the app starts as hosted. */
const LOAD_TIMEOUT_MS = 8_000;

export interface SelfhostAuthDeps {
  /**
   * Signs this phone out of `serverId`: ends a live call, stops its rings, then removes the
   * profile (`remove`) or keeps it, and makes hosted active. Set by `./switching`.
   */
  leave(serverId: string, remove: boolean): Promise<void>;
}

export interface SelfhostAuth {
  /** Reads the saved servers and the active one's token. Idempotent. */
  start(): Promise<void>;
  loaded(): boolean;
  /** Resolves when the active server's token has been read. */
  ready(): Promise<void>;
  /** For the active self-hosted server; `signed_out` with hosted active. */
  state(): AuthState;
  /** Why this phone was last signed out of a server; shown on the sign-in screen. */
  notice(): string | undefined;
  clearNotice(): void;
  subscribe(listener: () => void): () => void;
  /**
   * The identity check of this activation of `serverId` passed: the token may be sent from now
   * on. Until then requests carry none and the state is `loading`.
   */
  markChecked(serverId: string): void;
  /**
   * The identity check of `serverId` did not pass but did not show another server either (offline,
   * a server error, a stall): the person shows as signed in, and the token is held back (again)
   * until a later check passes.
   */
  markHeld(serverId: string): void;
  /** Signs out of the active server with `message`, removing its profile or keeping it. */
  endSession(message: string, remove: boolean): Promise<void>;
  api: ApiAuth & { removed(message: string, sentToken?: string): void };
}

const LOADING: AuthState = { status: 'loading' };

/**
 * Sign-in with a paired self-hosted server: the device token from pairing is the session. There is
 * nothing to refresh; a token the server refuses ends the session on this phone.
 */
export function selfhostAuth(
  store: Pick<ProfileStore, 'load' | 'active' | 'secrets' | 'subscribe' | 'activate'>,
  deps: SelfhostAuthDeps,
): SelfhostAuth {
  let started: Promise<void> | undefined;
  let isLoaded = false;
  let tokenFor: string | undefined;
  let token: string | undefined;
  /** The server whose identity was checked since it became active. */
  let checkedFor: string | undefined;
  /** The server shown signed in while its token is held back (its check did not pass yet). */
  let heldFor: string | undefined;
  let lastNotice: string | undefined;
  let reading: Promise<void> = Promise.resolve();
  let readSeq = 0;
  let snapshot: AuthState = LOADING;
  const listeners = new Set<() => void>();

  const compute = (): AuthState => {
    if (!isLoaded) return LOADING;
    const active = store.active();
    if (active.kind !== 'selfhost') {
      return { status: 'signed_out', ...(lastNotice !== undefined && { notice: lastNotice }) };
    }
    if (tokenFor !== active.serverId) return LOADING;
    if (token === undefined) {
      return { status: 'signed_out', ...(lastNotice !== undefined && { notice: lastNotice }) };
    }
    if (checkedFor !== active.serverId && heldFor !== active.serverId) return LOADING;
    return { status: 'signed_in', userId: active.person.id, name: active.person.displayName };
  };
  const emit = () => {
    const next = compute();
    // A stable snapshot for useSyncExternalStore.
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const readToken = async (): Promise<void> => {
    const seq = ++readSeq;
    const active = store.active();
    if (active.kind !== 'selfhost') {
      tokenFor = undefined;
      token = undefined;
      checkedFor = undefined;
      heldFor = undefined;
      emit();
      return;
    }
    if (tokenFor === active.serverId && token !== undefined) return;
    tokenFor = undefined;
    token = undefined;
    checkedFor = undefined;
    heldFor = undefined;
    const secrets = await store.secrets(active.serverId).catch(() => undefined);
    if (seq !== readSeq) return;
    if (secrets === undefined) {
      // A profile without its token cannot sign in: keep it listed, fall back to hosted.
      await store.activate('hosted').catch(() => undefined);
      emit();
      return;
    }
    tokenFor = active.serverId;
    token = secrets.deviceToken;
    // Signed in to a server again: an old sign-out reason no longer applies.
    if (token !== undefined) lastNotice = undefined;
    emit();
  };

  store.subscribe(() => {
    if (isLoaded) reading = readToken();
  });

  const endSession = async (message: string, remove: boolean): Promise<void> => {
    const active = store.active();
    if (active.kind !== 'selfhost' || token === undefined) return;
    // Drop the token first: nothing may be sent with it again.
    token = undefined;
    lastNotice = message;
    emit();
    try {
      await deps.leave(active.serverId, remove);
    } catch {
      // Never stay on a server this phone is signed out of.
      await store.activate('hosted').catch(() => undefined);
    }
  };

  return {
    start() {
      started ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          store.load(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, LOAD_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        isLoaded = true;
        reading = readToken();
        await reading;
        emit();
      })();
      return started;
    },
    loaded: () => isLoaded,
    ready: () => reading,
    state: () => snapshot,
    notice: () => lastNotice,
    clearNotice() {
      if (lastNotice === undefined) return;
      lastNotice = undefined;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    markChecked(serverId) {
      const active = store.active();
      if (active.kind !== 'selfhost' || active.serverId !== serverId) return;
      checkedFor = serverId;
      heldFor = undefined;
      emit();
    },
    markHeld(serverId) {
      const active = store.active();
      if (active.kind !== 'selfhost' || active.serverId !== serverId) return;
      checkedFor = undefined;
      heldFor = serverId;
      emit();
    },
    endSession,
    api: {
      token() {
        const active = store.active();
        return active.kind === 'selfhost' &&
          tokenFor === active.serverId &&
          checkedFor === active.serverId
          ? token
          : undefined;
      },
      // A paired phone's token is not refreshed.
      refresh: () => Promise.resolve(undefined),
      // A refusal of a token this phone no longer uses (another server, or an older pairing) is
      // not about the active server.
      expired(sentToken) {
        if (sentToken !== undefined && sentToken !== token) return;
        void endSession(SIGNED_OUT_OF_SERVER, true);
      },
      removed(message, sentToken) {
        if (sentToken !== undefined && sentToken !== token) return;
        void endSession(message, true);
      },
    },
  };
}

/** When a server refuses the token without saying why. */
export const SIGNED_OUT_OF_SERVER =
  'This phone is no longer paired with the server. Pair it again with a new code.';

let leaveHook: SelfhostAuthDeps['leave'] = () => Promise.resolve();
/** Set by `./switching`, which knows how to end calls and rings. */
export function setSelfhostLeave(leave: SelfhostAuthDeps['leave']): void {
  leaveHook = leave;
}

/** The app's self-hosted sign-in. */
export const selfhost: SelfhostAuth = selfhostAuth(profileStore, {
  leave: (serverId, remove) => leaveHook(serverId, remove),
});
