import { isActive } from '@twring/contracts';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { apiAuth, setBeforeSignOut } from '@/auth';
import { twringApi } from '@/api';
import { mobileEnv } from '@/config/env';
import { activeServerUrl, onActiveServerChanged, useActiveServer } from '@/servers/active';
import { profileStore } from '../servers/profiles';
import { callBreadcrumb } from '@/observability/sentry';
import { audioRoutePlatform, callInterruptionPlatform } from '@/platform/audio-route';
import { deviceFacts } from '@/platform/device-facts';
import {
  callBackgroundService,
  onBackgroundEndPressed,
  onBackgroundStartRefused,
} from '@/platform/call-service';
import { playCallFeedback } from '@/platform/haptics';
import { microphonePermission } from '@/platform/microphone';

import { createCallApi } from './api';
import { AudioRoutes, type AudioRouteState } from './audio-routes';
import { CallInterruption, type CallInterruptionState } from './call-interruption';
import { CallController, type CallView } from './controller';
import { DeviceReporter } from './device-report';
import { feedbackFor } from './feedback';
import { LiveKitCallTransport } from './livekit-transport';
import { systemTimers } from './timers';

let controller: CallController | undefined;
/** Unregisters what the current controller hooked into the app (listeners, sign-out hook). */
let disposeController: (() => void) | undefined;
let currentInterruption: CallInterruption | undefined;

/** The call's audio output. Lives beside the controller; reset when a call finishes. */
export const audioRoutes = new AudioRoutes(audioRoutePlatform, (detail) =>
  callBreadcrumb({ event: 'audio_route_failed', detail }),
);

/**
 * The app's one call controller. It lives outside React so navigating, backgrounding, or unmounting
 * a screen can never silently drop a live call (MOBILE_PLATFORM_SPEC §11). Undefined when config is
 * missing.
 */
export function callController(): CallController | undefined {
  if (controller !== undefined || !mobileEnv.ok) return controller;
  const { env } = mobileEnv;
  const auth = apiAuth();
  const created = new CallController({
    api: createCallApi({
      baseUrl: activeServerUrl(),
      requireSecureMedia: env.CORD_ENV !== 'development',
      ...(auth && { auth }),
      rejectRedirects: profileStore.active().kind === 'selfhost',
    }),
    approvalApi: twringApi()!,
    createTransport: () => new LiveKitCallTransport(),
    microphone: microphonePermission,
    background: callBackgroundService,
    timers: systemTimers,
    telemetry: (event) => {
      callBreadcrumb(event);
      if (__DEV__) console.info('[call]', JSON.stringify(event));
    },
    onInvalidTransition: (state, event) => {
      if (__DEV__) console.warn(`[call] ignored ${event.type} in ${state.status}`);
    },
  });
  controller = created;
  // Signing out ends a live call first: its media must not outlive the session.
  let disposed = false;
  setBeforeSignOut(async () => {
    if (!disposed && isActive(created.getView().call)) await created.hangUp();
  });

  // The ongoing notification's End button hangs up like the on-screen one. With no call active
  // the service is stale (e.g. left by a JS reload): stop it rather than leave it running.
  const offEndPressed = onBackgroundEndPressed(() => {
    if (isActive(created.getView().call)) void created.hangUp();
    else void callBackgroundService.stop().catch(() => undefined);
  });
  const offStartRefused = onBackgroundStartRefused(() => created.backgroundStartRefused());
  // A start refused while backgrounded (Android 12+/14+) is retried once the app is visible.
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') created.retryBackground();
  });

  // A phone call during the call: mute, show a notice, give route and mic back when it ends.
  const interruption = new CallInterruption(
    {
      isMuted: () => created.getView().muted,
      setMuted: (muted) => created.setMuted(muted),
      restoreRoute: () => audioRoutes.restore(),
    },
    (detail) => callBreadcrumb({ event: 'audio_route_failed', detail }),
  );
  currentInterruption = interruption;
  // Route and interruption events are watched for the whole call, screen off included.
  let stopWatching: (() => void) | undefined;
  const watch = (active: boolean) => {
    if (active && stopWatching === undefined) {
      const offRoutes = audioRoutePlatform.watch?.(() => void audioRoutes.refresh());
      const offInterruption = callInterruptionPlatform.watch?.((phase) => {
        void interruption.handle(phase);
      });
      stopWatching = () => {
        offRoutes?.();
        offInterruption?.();
      };
    } else if (!active && stopWatching !== undefined) {
      stopWatching();
      stopWatching = undefined;
      interruption.reset();
    }
  };

  // Device and audio route go to the gateway when the call is live and on each route change.
  const reporter = new DeviceReporter(deviceFacts(), (info) => created.reportDevice(info));
  const report = () =>
    reporter.update(created.getView().call.status, audioRoutes.getState().current);
  const offReportRoute = audioRoutes.subscribe(report);

  let previous = created.getView().call;
  const offView = created.subscribe(() => {
    const next = created.getView().call;
    report();
    if (next === previous) return;
    const feedback = feedbackFor(previous, next);
    if (feedback !== undefined) playCallFeedback(feedback);
    if (isActive(previous) && !isActive(next)) audioRoutes.reset();
    watch(isActive(next));
    previous = next;
  });
  disposeController = () => {
    disposed = true;
    offEndPressed();
    offStartRefused();
    appState.remove();
    offView();
    offReportRoute();
    watch(false);
    if (currentInterruption === interruption) currentInterruption = undefined;
  };
  return created;
}

// A switched server needs a controller for its address. A call still live on the old one is ended.
onActiveServerChanged(() => {
  const old = controller;
  controller = undefined;
  disposeController?.();
  disposeController = undefined;
  if (old !== undefined && isActive(old.getView().call)) void old.hangUp().catch(() => undefined);
});

const IDLE_VIEW: CallView = { call: { status: 'IDLE' }, muted: false };
const noopSubscribe = () => () => undefined;

export function useCallView(): CallView {
  // Reads a mutable controller after subscribing: the React Compiler must not cache that read.
  'use no memo';
  // A server switch builds a new controller: re-render so the subscription follows it.
  useActiveServer();
  const active = callController();
  return useSyncExternalStore(
    active?.subscribe ?? noopSubscribe,
    active?.getView ?? (() => IDLE_VIEW),
  );
}

export function useAudioRoutes(): AudioRouteState {
  return useSyncExternalStore(audioRoutes.subscribe, audioRoutes.getState);
}

const NOT_PAUSED: CallInterruptionState = { paused: false };

/** Whether a phone call has paused the Twring call (shown as a calm notice on the call screen). */
export function useCallInterruption(): CallInterruptionState {
  'use no memo';
  useActiveServer();
  callController();
  const active = currentInterruption;
  return useSyncExternalStore(
    active?.subscribe ?? noopSubscribe,
    active?.getState ?? (() => NOT_PAUSED),
  );
}

/** True when route changes arrive as events, so the call screen need not poll. */
export const audioRoutesWatched = audioRoutePlatform.watch !== undefined;
