import type { Breadcrumb, ErrorEvent } from '@sentry/react-native';

/**
 * Crash-report scrubbing (SECURITY_AND_PRIVACY): no transcripts, no tokens, no email addresses,
 * and the user only as a hash. Pure, so it is unit-tested without the native SDK.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE =
  /\b(token|access_token|refresh_token|api[_-]?key|apikey|secret|password|authorization)=([^&\s]+)/gi;
/** Long opaque strings (API keys, hex secrets) that are neither words nor ids we recognise. */
const OPAQUE = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;

export function scrubText(text: string): string {
  return text
    .replace(JWT, '[token]')
    .replace(BEARER, '$1 [token]')
    .replace(KEY_VALUE, '$1=[redacted]')
    .replace(EMAIL, '[email]')
    .replace(OPAQUE, '[redacted]');
}

const FILE_PATH = /(file:\/\/\S+|\/(?:var|private|Users|data|storage)\/\S+)/g;

/** A thrown value as one short line for a report: name and message, scrubbed, paths removed. */
export function clientErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : 'UnknownError';
  return scrubText(raw.replace(FILE_PATH, '[path]')).slice(0, 300);
}

/** One-way, stable pseudonym for a user id (FNV-1a 64-bit), so reports can be grouped by user. */
export function hashUserId(userId: string): string {
  const input = `cord-user:${userId}`;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    const unit = input.charCodeAt(i);
    for (const byte of [unit & 0xff, unit >> 8]) {
      hash ^= BigInt(byte);
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
  }
  return `u_${hash.toString(16).padStart(16, '0')}`;
}

/** Call breadcrumbs carry state names, codes, timings, and the opaque call id; keep those. */
const KEPT_BREADCRUMB_CATEGORIES = new Set(['call', 'navigation']);

/** Opaque Twring ids, kept as they are so a report can be matched to server logs. */
const ID_KEYS = new Set(['call_id', 'session_id', 'request_id']);

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, ID_KEYS.has(k) ? v : scrubValue(v)]),
    );
  }
  return value;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const scrubbed: Breadcrumb = { ...breadcrumb };
  if (!KEPT_BREADCRUMB_CATEGORIES.has(breadcrumb.category ?? '')) {
    // Console output and HTTP breadcrumbs carry free text and URLs.
    delete scrubbed.message;
    delete scrubbed.data;
    return scrubbed;
  }
  if (scrubbed.message !== undefined) scrubbed.message = scrubText(scrubbed.message);
  if (scrubbed.data !== undefined) scrubbed.data = scrubValue(scrubbed.data) as Breadcrumb['data'];
  return scrubbed;
}

/** Last line of defence for every event, including ones the SDK captures on its own. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const scrubbed: ErrorEvent = { ...event };
  if (scrubbed.request) {
    const request = { ...scrubbed.request };
    delete request.data;
    delete request.headers;
    delete request.cookies;
    delete request.query_string;
    if (request.url !== undefined) request.url = request.url.split('?')[0];
    scrubbed.request = request;
  }
  // Only the hashed id ever set by setCrashUser; never email, name, or IP address.
  const id = scrubbed.user?.id;
  if (typeof id === 'string' && id.startsWith('u_')) scrubbed.user = { id };
  else delete scrubbed.user;
  delete scrubbed.extra;
  if (scrubbed.message !== undefined) scrubbed.message = scrubText(scrubbed.message);
  if (scrubbed.exception?.values) {
    scrubbed.exception = {
      ...scrubbed.exception,
      values: scrubbed.exception.values.map((exception) => ({
        ...exception,
        ...(exception.value !== undefined && { value: scrubText(exception.value) }),
      })),
    };
  }
  if (scrubbed.breadcrumbs) scrubbed.breadcrumbs = scrubbed.breadcrumbs.map(scrubBreadcrumb);
  return scrubbed;
}
