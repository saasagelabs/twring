import { mobileAuthConfig } from '@twring/config/mobile';
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import { createClient } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import { mobileEnv } from '@/config/env';
import { migrateKeychainOnce } from '@/platform/keychain';
import { KEYS_TO_MIGRATE, secureStore } from '@/platform/secure-store';
import { selfhost } from '@/servers/auth';
import { profileStore } from '@/servers/profiles';
import { configureSwitching } from '@/servers/switching';

import {
  apiAuthFor,
  AuthController,
  GoogleSignInError,
  type ApiAuth,
  type AuthState,
  type GoogleSignIn,
} from './controller';
import { appleSignIn } from './apple-sign-in';
import { googleBrowserSignIn } from './google-browser';
import { installRandomValues } from './random-values';
import { chunkedSecureStorage } from './storage';
import { supabaseBackend } from './supabase-backend';

/** Where Supabase keeps the session (chunked: `cord.auth.count`, `cord.auth.0`, ...). */
const AUTH_STORAGE_KEY = 'cord.auth';

export { SESSION_ENDED_NOTICE, type AuthState } from './controller';

let controller: AuthController | undefined;
let deleteOwnAccount: (() => Promise<void>) | undefined;
let beforeSignOut: (() => Promise<void>) | undefined;

/**
 * Registers what must happen before signing out (ending a live call). Set by the call module, so
 * auth does not import the call stack.
 */
export function setBeforeSignOut(hook: () => Promise<void>): void {
  beforeSignOut = hook;
}

/** More work before signing out (removing this phone's push registration), after `beforeSignOut`. */
const alsoBeforeSignOut: (() => Promise<void>)[] = [];
export function addBeforeSignOut(hook: () => Promise<void>): void {
  alsoBeforeSignOut.push(hook);
}

async function runBeforeSignOut(): Promise<void> {
  await beforeSignOut?.();
  for (const hook of alsoBeforeSignOut) await hook().catch(() => undefined);
}

// Switching servers ends calls and clears chats the same way, and signs out of hosted.
configureSwitching({
  beforeSignOut: runBeforeSignOut,
  hosted: () => {
    const active = authController();
    return (
      active && {
        signedIn: active.getState().status === 'signed_in',
        signOut: () => active.signOut(),
      }
    );
  },
});

/**
 * The app's sign-in controller. Undefined when sign-in is not configured, which config allows only
 * in development (the gateway then runs AUTH_MODE=dev).
 */
export function authController(): AuthController | undefined {
  if (controller !== undefined || !mobileEnv.ok) return controller;
  const config = mobileAuthConfig(mobileEnv.env);
  if (config === undefined) return undefined;

  // Before any PKCE sign-in: Supabase needs crypto.getRandomValues (see random-values.ts).
  installRandomValues();
  // Keychain / Android Keystore, chunked under the secure store's value size limit, and readable
  // when a ring wakes Twring on a locked phone. Items from older builds are re-saved once.
  const storage = chunkedSecureStorage(secureStore);
  void migrateKeychainOnce({
    store: secureStore,
    keys: KEYS_TO_MIGRATE,
    resaveSession: () => storage.resave(AUTH_STORAGE_KEY),
  });
  const supabase = createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      storage,
      storageKey: AUTH_STORAGE_KEY,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      // The iPhone's Google sign-in runs in the browser and returns a code (PKCE). ID-token
      // sign-ins do not use it.
      flowType: 'pkce',
    },
  });
  // Refresh only while the app is in the foreground, as Supabase recommends for React Native.
  if (AppState.currentState === 'active') void supabase.auth.startAutoRefresh();
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  });

  GoogleSignin.configure({
    webClientId: config.googleWebClientId,
    ...(config.googleIosClientId !== undefined && { iosClientId: config.googleIosClientId }),
  });

  const backend = supabaseBackend(supabase.auth);
  // supabase/migrations: deletes auth.uid()'s own account; no arguments, signed-in users only.
  deleteOwnAccount = async () => {
    const { error } = await supabase.rpc('delete_my_account');
    if (error) throw new Error(`delete_my_account failed: ${error.code ?? 'unknown'}`);
  };

  const deviceGoogle: GoogleSignIn = {
    async signIn() {
      try {
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
        const response = await GoogleSignin.signIn();
        if (!isSuccessResponse(response)) return { type: 'cancelled' };
        return { type: 'success', idToken: response.data.idToken };
      } catch (error) {
        if (isErrorWithCode(error)) {
          if (error.code === statusCodes.SIGN_IN_CANCELLED) return { type: 'cancelled' };
          if (error.code === statusCodes.IN_PROGRESS) throw new GoogleSignInError('in_progress');
          if (error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
            throw new GoogleSignInError('play_services');
          }
        }
        throw new GoogleSignInError('failed');
      }
    },
    async signOut() {
      await GoogleSignin.signOut().catch(() => undefined);
    },
  };

  // The iPhone: Google in Apple's sign-in sheet and Sign in with Apple (App Store guideline 4.8).
  const ios = Platform.OS === 'ios';
  const google = ios
    ? googleBrowserSignIn(
        supabase.auth,
        (url, redirectTo) => WebBrowser.openAuthSessionAsync(url, redirectTo),
        Linking.createURL('auth/callback'),
      )
    : deviceGoogle;

  controller = new AuthController({
    backend,
    google,
    ...(ios && { apple: appleSignIn }),
    beforeSignOut: runBeforeSignOut,
  });
  controller.start();
  // Signed in to Twring's service again: a self-hosted server's sign-out reason no longer applies.
  const created = controller;
  created.subscribe(() => {
    if (created.getState().status === 'signed_in') selfhost.clearNotice();
  });
  return controller;
}

/**
 * Deletes the signed-in user's own sign-in account (Supabase RPC `delete_my_account`). Rejects
 * when sign-in is not configured or the call fails; the caller then offers a retry.
 */
export function deleteSignInAccount(): Promise<void> {
  authController();
  return deleteOwnAccount?.() ?? Promise.reject(new Error('sign-in is not configured'));
}

/** Token hooks for the API clients; undefined when sign-in is not configured. */
export function apiAuth(): ApiAuth | undefined {
  if (profileStore.active().kind === 'selfhost') return selfhost.api;
  const active = authController();
  return active && apiAuthFor(active);
}

/** Token hooks for Twring's own service, whichever server is active (hosted push registration). */
export function hostedApiAuth(): ApiAuth | undefined {
  const active = authController();
  return active && apiAuthFor(active);
}

/** Authorization header for requests made outside the API clients (voice samples). */
export function authHeaders(): Record<string, string> {
  const token =
    profileStore.active().kind === 'selfhost'
      ? selfhost.api.token()
      : authController()?.accessToken();
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

const DISABLED: AuthState = { status: 'disabled' };
const LOADING: AuthState = { status: 'loading' };
const noopSubscribe = () => () => undefined;

let combined: AuthState = LOADING;
/**
 * The signed-in state: the active self-hosted server's when one is active, else Twring's own. A
 * sign-out from a server shows its reason on the sign-in screen. Loading until the saved servers
 * are read. Stable between changes, for useSyncExternalStore.
 */
function currentAuth(): AuthState {
  let next: AuthState;
  if (!selfhost.loaded()) next = LOADING;
  else if (profileStore.active().kind === 'selfhost') next = selfhost.state();
  else {
    const hosted = authController()?.getState() ?? DISABLED;
    const notice = selfhost.notice();
    next =
      hosted.status === 'signed_out' && hosted.notice === undefined && notice !== undefined
        ? { status: 'signed_out', notice }
        : hosted;
  }
  if (next !== combined && JSON.stringify(next) !== JSON.stringify(combined)) combined = next;
  return combined;
}

function subscribeAuth(listener: () => void): () => void {
  const offHosted = (authController()?.subscribe ?? noopSubscribe)(listener);
  const offSelfhost = selfhost.subscribe(listener);
  return () => {
    offHosted();
    offSelfhost();
  };
}

export function useAuth(): AuthState {
  void selfhost.start();
  return useSyncExternalStore(subscribeAuth, currentAuth);
}
