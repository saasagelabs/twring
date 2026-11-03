import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import type { CallTelemetryEvent } from '@/call/controller';
import type { MobileEnvResult } from '@/config/env';
import { clientErrorMessage } from './scrub';

import { hashUserId, scrubBreadcrumb, scrubEvent } from './scrub';

let enabled = false;

/**
 * Crash reporting. Off without EXPO_PUBLIC_SENTRY_DSN. Never sends PII, audio, or transcript
 * content: every event and breadcrumb passes `scrubEvent` (no tokens, no emails), and the user is
 * only a hash. Call breadcrumbs carry only state names, codes, timings, and the opaque call ID.
 */
export function initSentry(result: MobileEnvResult): boolean {
  if (!result.ok || result.env.SENTRY_DSN === undefined) return false;
  const version = Constants.expoConfig?.version ?? '0.0.0';
  Sentry.init({
    dsn: result.env.SENTRY_DSN,
    environment: result.env.CORD_ENV,
    release: `cord-mobile@${version}`,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
  enabled = true;
  return true;
}

/** Tags reports with a hash of the signed-in user (never the id itself); undefined clears it. */
export function setCrashUser(userId: string | undefined): void {
  if (!enabled) return;
  Sentry.setUser(userId === undefined ? null : { id: hashUserId(userId) });
}

export function callBreadcrumb(event: CallTelemetryEvent): void {
  Sentry.addBreadcrumb({
    category: 'call',
    level: 'info',
    message: event.event,
    data: { ...event },
  });
}

/** Report a client failure: the stage plus the scrubbed native message (no file paths). */
export function reportClientError(stage: string, error: unknown): void {
  if (!enabled) return;
  Sentry.captureException(new Error(`${stage}: ${clientErrorMessage(error)}`), {
    tags: { stage, platform: Platform.OS },
  });
}

/** iOS's name for the session category a call uses (`.playAndRecord`, CordRing.swift). */
const CALL_AUDIO_CATEGORY = 'AVAudioSessionCategoryPlayAndRecord';

/**
 * iOS: an audio route change or interruption during a call. Each becomes a breadcrumb; the kinds
 * that can silence a call are also reported: an interruption, no route, and a category change that
 * leaves the call's play-and-record session or leaves no output (a plain Speaker or Phone switch
 * keeps both, so it is only a breadcrumb).
 */
export function reportAudioEvent(event: Record<string, unknown>): void {
  if (!enabled) return;
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === 'string') data[key] = value.slice(0, 60);
  }
  Sentry.addBreadcrumb({ category: 'call', level: 'info', message: 'audio_event', data });
  const silencing =
    (data.kind === 'interruption' && data.reason === 'began') ||
    (data.reason === 'category_change' &&
      (data.category !== CALL_AUDIO_CATEGORY || data.output === 'none')) ||
    data.reason === 'no_route';
  if (silencing) {
    Sentry.captureMessage(`call_audio_${data.kind ?? 'event'}_${data.reason ?? 'unknown'}`, {
      level: 'warning',
      tags: { platform: Platform.OS, ...(data.output !== undefined && { output: data.output }) },
    });
  }
}

/** This phone's native seal code failed its self-test (sealed rings cannot open). No values. */
export function reportSealSelfTestFailed(): void {
  if (!enabled) return;
  Sentry.addBreadcrumb({ category: 'ring', level: 'error', message: 'seal_self_test_failed' });
  Sentry.captureMessage('seal_self_test_failed', {
    level: 'error',
    tags: { platform: Platform.OS },
  });
}

export const wrapRoot = Sentry.wrap;
