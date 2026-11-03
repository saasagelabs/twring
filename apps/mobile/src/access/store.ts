import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { twringApi, type ErrorCopy, apiErrorCopy } from '../api';
import { ApiError, setNotInvitedHandler } from '../api/client';
import type { AuthState } from '../auth';
import { profileStore } from '../servers/profiles';

import { rememberMember, rememberedMember } from './memory';

export type AccessState =
  | { status: 'unknown' }
  | { status: 'checking' }
  | { status: 'member' }
  | { status: 'waitlist'; email?: string }
  | { status: 'error' };

let state: AccessState = { status: 'unknown' };
/** The waiting screen's re-check in flight (recheckAccess); dropped when the account changes. */
let recheck: Promise<void> | undefined;
let auth: AuthState = { status: 'loading' };
let identity: string | undefined;
let generation = 0;
const listeners = new Set<() => void>();

function setState(next: AccessState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

export const getAccessState = (): AccessState => state;
export const accessIdentity = (): string | undefined => identity;
export const subscribeAccess = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useAccess(): AccessState {
  return useSyncExternalStore(subscribeAccess, getAccessState);
}

/** The user the access state belongs to. A hook, not a render-time read: React Compiler caches those. */
export function useAccessIdentity(): string | undefined {
  return useSyncExternalStore(subscribeAccess, accessIdentity);
}

export function resetAccess(nextAuth: AuthState): void {
  auth = nextAuth;
  const nextIdentity = nextAuth.status === 'signed_in' ? nextAuth.userId : undefined;
  if (nextIdentity !== identity || nextAuth.status === 'signed_out') {
    identity = nextIdentity;
    generation += 1;
    recheck = undefined;
    setState({ status: 'unknown' });
    if (nextAuth.status === 'signed_out') void rememberMember(undefined);
  }
  if (nextAuth.status === 'disabled' && state.status !== 'member') {
    generation += 1;
    setState({ status: 'member' });
  }
}

export async function checkAccess(nextAuth?: AuthState): Promise<void> {
  if (nextAuth) resetAccess(nextAuth);
  if (auth.status !== 'signed_in') return;
  // A self-hosted server has no access list: a paired person is a member.
  if (profileStore.active().kind === 'selfhost') {
    if (state.status !== 'member') {
      generation += 1;
      setState({ status: 'member' });
    }
    return;
  }
  if (state.status === 'checking' || state.status === 'member' || state.status === 'waitlist')
    return;
  const userId = auth.userId;
  const requestGeneration = ++generation;
  setState({ status: 'checking' });
  // A member this phone already confirmed goes straight in, and the check runs behind it.
  const known = (await rememberedMember()) === userId;
  if (generation !== requestGeneration) return;
  if (known) setState({ status: 'member' });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const api = twringApi();
    if (!api?.getAccess) throw new ApiError('network');
    const result = await Promise.race([
      api.getAccess(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ApiError('timeout'));
        }, 8_000);
      }),
    ]);
    if (generation !== requestGeneration) return;
    void rememberMember(result.member ? userId : undefined);
    setState(result.member ? { status: 'member' } : { status: 'waitlist', email: result.email });
  } catch {
    // A known member stays in when the check fails: the server's gate still answers not_invited.
    if (generation === requestGeneration && !known) setState({ status: 'error' });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * From the waiting screen: asks again without leaving it (no loading flash), so someone let in
 * later (a free place the next day) goes straight in. One request at a time.
 */
export function recheckAccess(): Promise<void> {
  if (auth.status !== 'signed_in' || state.status !== 'waitlist') return Promise.resolve();
  recheck ??= (async () => {
    const userId = auth.status === 'signed_in' ? auth.userId : undefined;
    const requestGeneration = generation;
    try {
      const api = twringApi();
      if (!api?.getAccess) return;
      const result = await api.getAccess(new AbortController().signal);
      if (generation !== requestGeneration || !result.member || userId === undefined) return;
      generation += 1;
      void rememberMember(userId);
      setState({ status: 'member' });
    } catch {
      // Still waiting: the screen stays, and the next return to the app asks again.
    }
  })();
  const mine = recheck;
  void mine.finally(() => {
    if (recheck === mine) recheck = undefined;
  });
  return mine;
}

/** Checks again each time the app comes back to the front while the waiting screen shows. */
export function useRecheckOnReturn(): void {
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void recheckAccess();
    });
    return () => subscription.remove();
  }, []);
}

export async function redeem(
  code: string,
): Promise<{ ok: true } | { ok: false; error: ErrorCopy }> {
  const digits = code.replace(/\D/g, '');
  if (digits.length !== 6) {
    return { ok: false, error: apiErrorCopy(new ApiError('http', 'invite_invalid')) };
  }
  const requestGeneration = generation;
  try {
    const api = twringApi();
    if (!api?.redeemInvite) throw new ApiError('network');
    await api.redeemInvite(digits);
    if (generation === requestGeneration) {
      if (auth.status === 'signed_in') void rememberMember(auth.userId);
      setState({ status: 'member' });
    }
    return { ok: true };
  } catch (error) {
    if (generation === requestGeneration) {
      setState({ status: 'waitlist', email: auth.status === 'signed_in' ? auth.email : undefined });
    }
    return { ok: false, error: apiErrorCopy(error) };
  }
}

export function markNotInvited(): void {
  if (auth.status === 'signed_in') {
    void rememberMember(undefined);
    generation += 1;
    setState({ status: 'waitlist', email: auth.email });
  }
}

setNotInvitedHandler(markNotInvited);
