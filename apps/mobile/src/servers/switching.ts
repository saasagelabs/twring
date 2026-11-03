import { AppState } from 'react-native';

import { mobileEnv } from '../config/env';
import { sealKeys as nativeSealKeys, type SealKeys } from '../platform/seal-keys';

import { selfhost, setSelfhostLeave, type SelfhostAuth } from './auth';
import { profileStore, type ProfileStore } from './profiles';
import { serverReady } from './ready';
import { checkServer, type ServerCheckResult } from './server-check';

/** Ring registration per server (Task 8 fills these in). */
export interface ServerRingHooks {
  stop(serverId: string): Promise<void>;
  start(serverId: string): Promise<void>;
}

export interface SwitchingDeps {
  store: Pick<ProfileStore, 'active' | 'list' | 'secrets' | 'activate' | 'remove'>;
  auth: Pick<SelfhostAuth, 'ready' | 'endSession' | 'markChecked' | 'markHeld'>;
  sealKeys: Pick<SealKeys, 'remove'>;
  /** Ends a live call and clears chats (auth's sign-out hooks). */
  beforeSignOut(): Promise<void>;
  /** Twring's own sign-in; undefined when sign-in is not configured. */
  hosted(): { signedIn: boolean; signOut(): Promise<void> } | undefined;
  check(
    address: string,
    expected: { serverId: string; publicKey: string },
  ): Promise<ServerCheckResult>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  rings(): ServerRingHooks;
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel. */
  setTimer(fn: () => void, ms: number): () => void;
}

/** Identity re-checks on return to the front run at most this often. */
const CHECK_INTERVAL_MS = 10 * 60_000;
const LEAVE_TIMEOUT_MS = 8_000;
/** Waits before checking again a server whose check did not pass; the last one repeats. */
const RETRY_MS = [15_000, 30_000, 60_000, 5 * 60_000];

const NOT_SAVED: ServerCheckResult = {
  ok: false,
  reason: 'wrong_server',
  message: "That server isn't saved on this phone. Pair it again with a new code.",
};

export function createSwitching(deps: SwitchingDeps) {
  /** When each server last passed the check; only ok checks start the 10 minute wait. */
  const lastOk = new Map<string, number>();
  /** One check in flight per server. */
  const inFlight = new Map<string, Promise<void>>();
  /** The pending re-check of a held server. */
  let retry: { serverId: string; cancel: () => void } | undefined;
  /** How many waits came before the next one, per held server. */
  const retries = new Map<string, number>();

  const stopRetry = () => {
    retry?.cancel();
    retry = undefined;
  };
  const scheduleRetry = (serverId: string) => {
    stopRetry();
    const count = retries.get(serverId) ?? 0;
    retries.set(serverId, count + 1);
    const ms = RETRY_MS[Math.min(count, RETRY_MS.length - 1)];
    const cancel = deps.setTimer(() => {
      retry = undefined;
      void checkActiveServer();
    }, ms);
    retry = { serverId, cancel };
  };

  const quietly = (work: Promise<void>) => work.catch(() => undefined);

  /** Ends this phone's session with `serverId`, then removes its profile or keeps it. */
  async function signOutOfServer(serverId: string, remove: boolean): Promise<void> {
    await stopForServer(serverId);
    await removeLocally(serverId, remove);
  }

  /** The sign-out hooks and this server's rings: they may still use the phone's key. */
  async function stopForServer(serverId: string): Promise<void> {
    await quietly(deps.beforeSignOut());
    await quietly(deps.rings().stop(serverId));
  }

  /** The local part of a sign-out: sends nothing to the server. */
  async function removeLocally(serverId: string, remove: boolean): Promise<void> {
    if (remove) {
      await deps.store.remove(serverId);
      await quietly(deps.sealKeys.remove(serverId));
    }
    await deps.store.activate('hosted');
  }

  /**
   * Asks the active self-hosted server to prove it is still the one this phone paired with. The
   * token is sent only after a check that passed. `changed` signs out (keeping the profile). Any
   * other failure (offline, a server error, a stall) shows the person signed in but holds the token
   * back, and checks again after 15 s, 30 s, 60 s, then every 5 minutes, and on each return to the
   * front. `throttled` skips a server that passed less than 10 minutes ago.
   */
  function checkActiveServer(options: { throttled?: boolean } = {}): Promise<void> {
    const active = deps.store.active();
    if (active.kind !== 'selfhost') {
      stopRetry();
      return Promise.resolve();
    }
    const serverId = active.serverId;
    const running = inFlight.get(serverId);
    if (running !== undefined) return running;
    const passed = lastOk.get(serverId);
    if (options.throttled && passed !== undefined && deps.now() - passed < CHECK_INTERVAL_MS) {
      // A pass this recent proved this server: this activation of it may send the token.
      deps.auth.markChecked(serverId);
      return Promise.resolve();
    }
    const work = (async () => {
      const result = await deps
        .check(active.address, { serverId, publicKey: active.publicKey })
        .catch((): ServerCheckResult => ({ ok: false, reason: 'unreachable', message: '' }));
      const still = deps.store.active();
      if (still.kind !== 'selfhost' || still.serverId !== serverId) return;
      if (result.ok) {
        lastOk.set(serverId, deps.now());
        retries.delete(serverId);
        stopRetry();
        deps.auth.markChecked(serverId);
        return;
      }
      lastOk.delete(serverId);
      if (result.reason === 'changed') {
        retries.delete(serverId);
        stopRetry();
        await deps.auth.endSession(result.message, false);
        return;
      }
      deps.auth.markHeld(serverId);
      scheduleRetry(serverId);
    })().finally(() => inFlight.delete(serverId));
    inFlight.set(serverId, work);
    return work;
  }

  return {
    signOutOfServer,

    /** Signs out of the active self-hosted server, keeping it saved; hosted becomes active. */
    async switchToHosted(): Promise<void> {
      const active = deps.store.active();
      if (active.kind !== 'selfhost') return;
      await signOutOfServer(active.serverId, false);
    },

    /** Re-checks the saved server's identity, then signs out of hosted and makes it active. */
    async switchToServer(serverId: string): Promise<ServerCheckResult> {
      const profile = deps.store
        .list()
        .find((p) => p.kind === 'selfhost' && p.serverId === serverId);
      if (profile === undefined || profile.kind !== 'selfhost') return NOT_SAVED;
      const result = await deps.check(profile.address, {
        serverId: profile.serverId,
        publicKey: profile.publicKey,
      });
      if (!result.ok) return result;
      const active = deps.store.active();
      if (active.kind === 'selfhost') {
        if (active.serverId === serverId) return result;
        await signOutOfServer(active.serverId, false);
      } else {
        const hosted = deps.hosted();
        // Hosted sign-out runs the sign-out hooks itself.
        if (hosted?.signedIn) await quietly(hosted.signOut());
        else await quietly(deps.beforeSignOut());
      }
      // This check counts as the activation's own: the next start does not repeat it.
      lastOk.set(serverId, deps.now());
      retries.delete(serverId);
      await deps.store.activate(serverId);
      await deps.auth.ready();
      deps.auth.markChecked(serverId);
      await quietly(deps.rings().start(serverId));
      return result;
    },

    /**
     * Deletes this phone on the active server, then removes its profile, secrets and seal key
     * here. The token goes only to a server that proves it is the one this phone paired with; the
     * local removal happens whatever the check or the server says.
     */
    async leaveServer(): Promise<void> {
      const active = deps.store.active();
      if (active.kind !== 'selfhost') return;
      const check = await deps
        .check(active.address, { serverId: active.serverId, publicKey: active.publicKey })
        .catch(() => undefined);
      const secrets = check?.ok
        ? await deps.store.secrets(active.serverId).catch(() => undefined)
        : undefined;
      // Rings stop (and the sign-out hooks run) while the phone's key still works: once the
      // phone is deleted below, nothing more is sent with it.
      await stopForServer(active.serverId);
      if (secrets !== undefined) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LEAVE_TIMEOUT_MS);
        try {
          await deps.fetch(
            `${active.address}/v1/me/paired-devices/${encodeURIComponent(active.deviceId)}`,
            {
              method: 'DELETE',
              headers: { authorization: `Bearer ${secrets.deviceToken}` },
              redirect: 'error',
              signal: controller.signal,
            },
          );
        } catch {
          // Unreachable: the server keeps a stale device until an admin removes it.
        } finally {
          clearTimeout(timer);
        }
      }
      await removeLocally(active.serverId, true);
    },

    checkActiveServer,

    /**
     * Forgets a saved server on this phone only: its profile, secrets and seal key. The server is
     * not contacted (this phone stays listed there until an admin removes it).
     */
    async forgetServer(serverId: string): Promise<void> {
      const active = deps.store.active();
      if (active.kind === 'selfhost' && active.serverId === serverId) {
        await signOutOfServer(serverId, true);
        return;
      }
      if (retry?.serverId === serverId) stopRetry();
      lastOk.delete(serverId);
      retries.delete(serverId);
      await deps.store.remove(serverId);
      await quietly(deps.sealKeys.remove(serverId));
    },
  };
}

let ringHooks: ServerRingHooks = {
  stop: () => Promise.resolve(),
  start: () => Promise.resolve(),
};
/** Ring registration per server; set by the ring module. */
export function setServerRingHooks(hooks: ServerRingHooks): void {
  ringHooks = hooks;
}

let wiring: Pick<SwitchingDeps, 'beforeSignOut' | 'hosted'> = {
  beforeSignOut: () => Promise.resolve(),
  hosted: () => undefined,
};
/** Called by auth, so this module does not import the hosted sign-in. */
export function configureSwitching(next: Pick<SwitchingDeps, 'beforeSignOut' | 'hosted'>): void {
  wiring = next;
}

const switching = createSwitching({
  store: profileStore,
  auth: selfhost,
  sealKeys: nativeSealKeys,
  beforeSignOut: () => wiring.beforeSignOut(),
  hosted: () => wiring.hosted(),
  check: (address, expected) =>
    checkServer(address, expected, {
      fetch: (url, init) => fetch(url, init),
      now: Date.now,
      allowHttp: mobileEnv.ok && mobileEnv.env.CORD_ENV === 'development',
    }),
  fetch: (url, init) => fetch(url, init),
  rings: () => ringHooks,
  now: Date.now,
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
});
setSelfhostLeave(switching.signOutOfServer);

export const switchToHosted = (): Promise<void> => switching.switchToHosted();
export const switchToServer = (serverId: string): Promise<ServerCheckResult> =>
  switching.switchToServer(serverId);
export const leaveServer = (): Promise<void> => switching.leaveServer();
export const forgetServer = (serverId: string): Promise<void> => switching.forgetServer(serverId);

/**
 * Resolves once the saved servers are read and the active server's identity check ran, so its
 * token is released. Rings that start before the root layout mounts wait on this.
 */
export function serverChecked(): Promise<void> {
  return serverReady({
    active: () => profileStore.active(),
    start: () => selfhost.start(),
    check: () => switching.checkActiveServer({ throttled: true }),
  });
}

/** Re-checks the active server's identity now and on each return to the front. */
export function watchServerIdentity(): () => void {
  void selfhost.start().then(() => switching.checkActiveServer());
  // A newly active server (paired, or switched to) is checked before its token is sent.
  // Throttled: a server switched to was checked just before it became active.
  const offChanged = profileStore.subscribe(
    () => void switching.checkActiveServer({ throttled: true }),
  );
  const subscription = AppState.addEventListener('change', (next) => {
    if (next === 'active') void switching.checkActiveServer({ throttled: true });
  });
  return () => {
    subscription.remove();
    offChanged();
  };
}
