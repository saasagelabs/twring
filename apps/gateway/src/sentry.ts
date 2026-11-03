import type { GatewayEnv } from '@twring/config/gateway';
import * as Sentry from '@sentry/node';
import type { Breadcrumb, ErrorEvent, EventHint } from '@sentry/node';

import { SanitizedErrorCopy, safeUrl, toSafeError } from './redact';

/**
 * Sentry skeleton. A no-op unless SENTRY_DSN is configured. Never sends PII, request bodies,
 * headers, or transcript content (docs/SECURITY_AND_PRIVACY.md).
 */
export function initSentry(env: GatewayEnv): boolean {
  if (env.SENTRY_DSN === undefined) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.CORD_ENV,
    release: env.CORD_RELEASE,
    // SDK v11 collects most request data by default; opt out of everything that could carry
    // credentials, transcripts, or agent payloads.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  return true;
}

const WITHHELD = 'message withheld by log policy';

/**
 * Breadcrumbs (console output, HTTP calls) carry arbitrary free text and URLs. Keep only the
 * structural fields; drop message and data.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const structural = { ...breadcrumb };
  delete structural.message;
  delete structural.data;
  return structural;
}

/**
 * Last line of defense for every event, including ones the SDK captures on its own (uncaught
 * exceptions, auto-instrumentation) that never went through captureError. Exception text is kept
 * only when the original exception is a SanitizedErrorCopy (redact.ts policy); otherwise it is
 * withheld, never pattern-guessed.
 */
export function scrubEvent(event: ErrorEvent, hint?: EventHint): ErrorEvent {
  if (event.request) {
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    if (event.request.url !== undefined) event.request.url = safeUrl(event.request.url);
  }
  // The gateway never attaches a user or free-form extras; drop any an integration added.
  delete event.user;
  delete event.extra;
  if (event.message !== undefined) event.message = WITHHELD;
  const trusted = hint?.originalException instanceof SanitizedErrorCopy;
  for (const exception of event.exception?.values ?? []) {
    if (!trusted && exception.value !== undefined) exception.value = WITHHELD;
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  return event;
}

/** Captures a sanitized copy (redact.ts policy); the raw error object never reaches Sentry. */
export function captureError(error: unknown, context: { requestId?: string } = {}): void {
  Sentry.captureException(toSafeError(error), { tags: { request_id: context.requestId } });
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  await Sentry.close(timeoutMs);
}
