import { isActive } from '@twring/contracts';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Alert, AppState, Platform } from 'react-native';

import { relayUrl } from '@twring/config/mobile';

import { twringApi } from '@/api';
import { createTwringApi, type TwringApi } from '@/api/client';
import { appVersionLabel } from '@/api/app-version';
import { addBeforeSignOut, authController, hostedApiAuth } from '@/auth';
import { mobileEnv } from '@/config/env';
import { reportSealSelfTestFailed } from '@/observability/sentry';
import { sealKeys } from '@/platform/seal-keys';
import { onActiveServerChanged } from '@/servers/active';
import { selfhost } from '@/servers/auth';
import { profileStore } from '@/servers/profiles';
import { isSealedPush, openedSealedRoute } from '@/servers/sealed-push';
import { answerWhenReady } from '@/servers/ready';
import { createRingRegistration, selfhostRegistrationDeps } from '@/servers/ring-registration';
import { serverChecked, setServerRingHooks } from '@/servers/switching';
import { callController } from '@/call/session';
import { startCall } from '@/call/start';
import { autoListenTarget } from '@/threads/auto-listen';
import { ringPlatform } from '@/platform/ring';
import { secureStore } from '@/platform/secure-store';

import { flushDeclines } from './declines';
import { parsePush, type RegisterDeviceRequest, type RingPush } from './protocol';
import { loadDeviceId } from './device-id';
import { showsInAppRing } from './in-app-ring';
import { answerSystemRing, type AnsweredRoute, type SystemAnswerDeps } from './system-answer';
import { answeredRing, openedNotificationRoute } from './system-call';

const NOTIFICATIONS_ASKED_KEY = 'cord.ring_notifications_asked';
const PENDING_DEVICE_KEY = 'cord.ring_pending_device';

let deviceIdPromise: Promise<string> | undefined;

/** This install's id (device-id.ts). A failed read is retried on the next call. */
function deviceId(): Promise<string> {
  deviceIdPromise ??= loadDeviceId(secureStore, Platform.OS === 'ios' ? 'ios' : 'android').catch(
    (error: unknown) => {
      deviceIdPromise = undefined;
      throw error;
    },
  );
  return deviceIdPromise;
}

function appVariant(): RegisterDeviceRequest['app_variant'] {
  const value: unknown = Constants.expoConfig?.extra?.appVariant;
  return value === 'staging' || value === 'production' ? value : 'development';
}

let hostedClient: TwringApi | undefined;
/**
 * Twring's own service, whatever server is active: hosted registration never goes to a
 * self-hosted server.
 */
function hostedApi(): TwringApi | undefined {
  if (hostedClient !== undefined || !mobileEnv.ok) return hostedClient;
  const auth = hostedApiAuth();
  if (auth === undefined) return undefined;
  hostedClient = createTwringApi({
    baseUrl: mobileEnv.env.API_BASE_URL,
    requireSecureMedia: mobileEnv.env.CORD_ENV !== 'development',
    appVersion: appVersionLabel(Constants.expoConfig, Platform.OS),
    auth,
  });
  return hostedClient;
}

/** This phone's push registration with whichever server is active. */
export const ringRegistration = createRingRegistration({
  active: () => profileStore.active(),
  base: {
    getToken: () => ringPlatform.getPushToken(),
    deviceId,
    setRingAccount: (ref) => ringPlatform.setRingAccount(ref),
    deleteToken: () => ringPlatform.deletePushToken(),
    getPendingDeviceId: () => secureStore.getItemAsync(PENDING_DEVICE_KEY).catch(() => null),
    setPendingDeviceId: async (id) => {
      if (id === null) await secureStore.deleteItemAsync(PENDING_DEVICE_KEY);
      else await secureStore.setItemAsync(PENDING_DEVICE_KEY, id);
    },
    appVariant: appVariant(),
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    // Android sends the token only with notifications on (no ring could show without them). iOS
    // rings through CallKit, which needs no notification permission.
    notificationsAllowed: () =>
      Platform.OS !== 'android' || ringPlatform.permissions().notifications,
    ...(ringPlatform.getAlertToken !== undefined && {
      getAlertToken: () => ringPlatform.getAlertToken?.() ?? Promise.resolve(null),
    }),
  },
  hosted: {
    register: async (id, request) => {
      await hostedApi()?.registerDevice(id, request);
    },
    unregister: async (id) => {
      await hostedApi()?.unregisterDevice(id);
    },
  },
  selfhost: (profile) =>
    selfhostRegistrationDeps(profile, {
      fetch: (url, init) => fetch(url, init),
      relayUrl: mobileEnv.ok ? relayUrl(mobileEnv.env) : '',
      ready: serverChecked,
      token: () => selfhost.api.token(),
    }),
  sealSelfTest: () => sealKeys.selfTest(),
  reportSealSelfTestFailed,
});

/** The active profile's registration (Settings: forget, rings off). */
export const pushRegistration = {
  forget: () => ringRegistration.current().forget(),
  signedOut: () => ringRegistration.current().signedOut(),
};

onActiveServerChanged(() => ringRegistration.activeChanged());
setServerRingHooks({
  start: (serverId) => ringRegistration.startForServer(serverId),
  stop: (serverId) => ringRegistration.stopForServer(serverId),
});

// Signing out first removes this phone's registration, while the session can still do it.
addBeforeSignOut(() => pushRegistration.signedOut());

/** Sends declines tapped on the notification. */
export async function sendQueuedDeclines(): Promise<void> {
  const api = twringApi();
  if (api === undefined) return;
  await flushDeclines(
    {
      take: () => ringPlatform.takePendingDeclines(),
      requeue: (id) => ringPlatform.queueDecline(id),
    },
    (id, request) => api.declineInvite(id, request),
  );
}

/** The invite whose incoming-call screen is showing, so a repeat push does not stack another. */
let showing: string | undefined;
export function setShowingInvite(inviteId: string | undefined): void {
  showing = inviteId;
}

/** Opens the incoming-call screen (app in the foreground, or opened from the ring). */
export function showIncoming(push: Pick<RingPush, 'invite_id'> & Partial<RingPush>): void {
  const call = callController()?.getView().call;
  if (
    !showsInAppRing({
      systemRingScreen: ringPlatform.systemRingScreen === true,
      showing,
      inviteId: push.invite_id,
      inCall: call !== undefined && isActive(call),
    })
  )
    return;
  showing = push.invite_id;
  router.push({
    pathname: '/incoming/[inviteId]',
    params: {
      inviteId: push.invite_id,
      ...(push.agent_id !== undefined && { agentId: push.agent_id }),
      ...(push.agent_name !== undefined && { agentName: push.agent_name }),
      ...(push.reason !== undefined && { reason: push.reason }),
      ...(push.expires_at !== undefined && { expiresAt: push.expires_at }),
      ...(push.server_time !== undefined && { serverTime: push.server_time }),
    },
  });
}

/** iOS: rings being answered from the system call screen, kept off the in-app ring screen. */
const systemAnswering = new Set<string>();
/** iOS: the screen for a ring answered while the app was in the background. */
let routeWhenActive: AnsweredRoute | undefined;

function showWhenActive(route: AnsweredRoute): void {
  if (AppState.currentState === 'active') router.push(route);
  else routeWhenActive = route;
}

function showRouteWhenActive(): void {
  const route = routeWhenActive;
  routeWhenActive = undefined;
  if (route !== undefined) router.push(route);
}

function systemAnswerDeps(): SystemAnswerDeps {
  const api = () => {
    const client = twringApi();
    if (client === undefined) throw new Error('signed out');
    return client;
  };
  return {
    answerInvite: (inviteId) => api().answerInvite(inviteId),
    latestAgentMessage: async (agentId) => {
      const page = await api().listMessages(agentId, { limit: 20 });
      return autoListenTarget(
        [...page.messages].sort((a, b) => a.seq - b.seq),
        true,
      );
    },
    speechSource: (agentId, messageId) => api().messageSpeechUrl(agentId, messageId),
    speakThenEnd: (source) => {
      if (ringPlatform.speakThenEndSystemCall) ringPlatform.speakThenEndSystemCall(source);
      else ringPlatform.endSystemCall?.();
    },
    endSystemCall: () => ringPlatform.endSystemCall?.(),
    joinCall: (target, session) => startCall(target, session, { open: false }),
    showWhenActive,
    notify: (title, body) => ringPlatform.notify?.(title, body),
  };
}

/** iOS: a ring answered on the system call screen, also after a cold start. */
function takeAnsweredRing(): void {
  const push = answeredRing(ringPlatform.takeAnsweredRing?.());
  if (push === undefined || systemAnswering.has(push.invite_id)) return;
  systemAnswering.add(push.invite_id);
  // A ring answered at cold start: a self-hosted server's token is released only after its check.
  void answerWhenReady({ active: () => profileStore.active(), ready: serverChecked }, () =>
    answerSystemRing(push, systemAnswerDeps()),
  ).finally(() => systemAnswering.delete(push.invite_id));
}

/** iOS: a tapped message or missed-call notification. */
function takeOpenedNotification(): void {
  const data = ringPlatform.takeOpenedNotification?.();
  if (isSealedPush(data)) {
    // From a self-hosted server: opened with its seal key; one that does not open just opens the app.
    void openedSealedRoute(data, {
      active: () => profileStore.active(),
      secrets: (serverId) => profileStore.secrets(serverId),
      now: () => Date.now(),
    }).then((route) => {
      if (route !== undefined) router.push(route);
    });
    return;
  }
  const route = openedNotificationRoute(data);
  if (route !== undefined) router.push(route);
}

/** iOS: hang-up and mute on the system call screen drive the app's call, and back. */
function syncSystemCall(): () => void {
  let wasActive = false;
  let wasMuted = false;
  const controller = callController();
  const unsubscribe = controller?.subscribe(() => {
    const view = controller.getView();
    const active = isActive(view.call);
    if (wasActive && !active) ringPlatform.endSystemCall?.();
    if (active && view.muted !== wasMuted) ringPlatform.setSystemCallMuted?.(view.muted);
    wasActive = active;
    wasMuted = view.muted;
  });
  const ended = ringPlatform.onSystemCallEnded?.(() => {
    const call = callController();
    if (call !== undefined && isActive(call.getView().call)) void call.hangUp();
  });
  const muted = ringPlatform.onSystemCallMuted?.((value) => {
    void callController()?.setMuted(value);
  });
  return () => {
    unsubscribe?.();
    ended?.();
    muted?.();
  };
}

/** A ring the push never delivered (or that came while the app was closed) still gets answered. */
async function showPendingInvite(): Promise<void> {
  const invites = await twringApi()
    ?.pendingInvites()
    .catch(() => undefined);
  const invite = invites?.find((pending) => !systemAnswering.has(pending.invite_id));
  if (invite !== undefined) showIncoming(invite);
}

/**
 * Asks once per install, in words, before the system prompt: agents ringing is the reason
 * notifications matter. A "no" is respected; Settings shows how to turn it on later.
 */
async function askForNotificationsOnce(): Promise<void> {
  if (ringPlatform.permissions().notifications) return;
  const asked = await secureStore.getItemAsync(NOTIFICATIONS_ASKED_KEY).catch(() => null);
  if (asked !== null) return;
  await secureStore.setItemAsync(NOTIFICATIONS_ASKED_KEY, '1').catch(() => undefined);
  Alert.alert(
    'Let your agents ring you',
    'When one of your agents needs you, Twring rings this phone like a call. Allow notifications ' +
      'so you hear it, even with the phone locked.',
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Allow', onPress: () => void allowNotifications() },
    ],
  );
}

/** Asks for notifications; once allowed, this phone is registered so agents can ring it. */
export async function allowNotifications(): Promise<boolean> {
  const granted = await ringPlatform.requestNotifications();
  if (granted) registerSignedIn();
  return granted;
}

/** Registers for the signed-in account of the active server (hosted, or a self-hosted person). */
function registerSignedIn(): void {
  if (profileStore.active().kind === 'selfhost') {
    const state = selfhost.state();
    if (state.status === 'signed_in') void ringRegistration.signedIn(state.userId);
    return;
  }
  const state = authController()?.getState();
  if (state?.status === 'signed_in') void ringRegistration.signedIn(state.userId);
  else if (state?.status === 'disabled') void ringRegistration.signedIn('dev-user');
}

/**
 * Wires the ring into the app while someone is signed in: registers for pushes, opens the
 * incoming-call screen on a ring, and sends declines tapped on the notification.
 */
export function useRingCoordinator(signedIn: boolean): void {
  useEffect(() => {
    if (!ringPlatform.supported) return;
    if (!signedIn) {
      void pushRegistration.signedOut();
      return;
    }
    const refresh = () => {
      registerSignedIn();
      void sendQueuedDeclines();
      void showPendingInvite();
      takeAnsweredRing();
      showRouteWhenActive();
      takeOpenedNotification();
    };
    refresh();
    void askForNotificationsOnce();
    const subscriptions = [
      authController()?.subscribe(() => {
        // Hosted sign-in changes only move the hosted registration.
        if (profileStore.active().kind !== 'hosted') return;
        const state = authController()?.getState();
        if (state?.status === 'signed_in') void ringRegistration.signedIn(state.userId);
        else if (state?.status === 'signed_out') void pushRegistration.signedOut();
      }),
      selfhost.subscribe(registerSignedIn),
      ringPlatform.onRing((data) => {
        const push = parsePush(data);
        if (push?.type === 'cord.ring') showIncoming(push);
      }),
      ringPlatform.onRingDeclined(() => void sendQueuedDeclines()),
      ringPlatform.onPushToken((token) => void ringRegistration.current().tokenRefreshed(token)),
      ringPlatform.onAlertToken?.(() => void ringRegistration.current().alertTokenRefreshed()),
      ringPlatform.onRingAnswered?.(takeAnsweredRing),
      ringPlatform.onNotificationOpened?.(takeOpenedNotification),
      syncSystemCall(),
    ];
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      subscriptions.forEach((unsubscribe) => unsubscribe?.());
      appState.remove();
    };
  }, [signedIn]);
}
