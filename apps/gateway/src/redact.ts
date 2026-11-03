import { ConfigError } from '@twring/config/gateway';

/**
 * Error sanitization policy (docs/SECURITY_AND_PRIVACY.md: redact secrets from logs).
 *
 * Error messages are free text written by whoever threw: provider SDKs, Node, Fastify, our own
 * code. They routinely embed credentials, URLs, request bodies, and transcript fragments in forms
 * no pattern list can recognize ("database password is hunter2"). So the policy is an allowlist,
 * not a denylist:
 *
 * 1. Raw error objects never reach a log line or Sentry. Only `sanitizeError`/`toSafeError`
 *    output does.
 * 2. A message is emitted only if Twring authored it as safe: a `SafeMessageError`, or a
 *    `ConfigError` (which names variables, never values). Every other message is replaced with a
 *    controlled description built from the error's name and code.
 * 3. Stacks keep only their `at ...` frame lines. V8 puts the message on the first stack line(s),
 *    so the raw stack would leak what rule 2 withheld.
 * 4. Only `name`, `code`, and `statusCode` survive from the original, and only in safe shapes.
 *    Arbitrary own properties (request configs, response bodies, headers) are dropped.
 * 5. `cause` chains follow the same rules to a bounded depth.
 *
 * `redactSecrets` pattern redaction is defense in depth for allowlisted text. It is never the
 * only control.
 */

/**
 * An error whose message Twring authored and guarantees contains no secrets, credentials, user
 * content, or transcript text. Only these messages (and ConfigError's) reach logs and Sentry.
 */
export class SafeMessageError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SafeMessageError';
    this.code = code;
  }
}

const REDACTED = '[REDACTED]';

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // Authorization schemes: "Bearer abc", "Basic abc", "Token abc".
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // Credentials in URLs: scheme://user:pass@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  // Named secrets as key=value, key: value, "key":"value", or query params. Skips values the
  // auth-scheme rule already handled, so "Authorization: Bearer x" stays readable.
  [
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization|x-api-key|dsn)["']?\s*[=:]\s*["']?)(?!\[REDACTED\]|(?:Bearer|Basic|Token)\s)[^\s"'&,;}]+/gi,
    `$1${REDACTED}`,
  ],
  // Well-known provider key prefixes (OpenAI/Anthropic-style sk-, Stripe-style sk_/pk_/rk_).
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, REDACTED],
];

/** Best-effort pattern redaction. Defense in depth only; see the policy above. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * A computer's link code rides in the path of the phone's link routes (ADR-025). It is a
 * short-lived secret: whoever reads it in time can approve that computer into their account.
 */
const LINK_CODE_PATH = /^(\/v1\/link-requests\/)[^/]+/;

/**
 * Drops the query string and fragment, which carry tokens far more often than paths do, and the
 * link code in a link route's path.
 */
export function safeUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const path = (cut === -1 ? url : url.slice(0, cut)).replace(LINK_CODE_PATH, '$1[code]');
  return cut === -1 ? path : `${path}?[query omitted]`;
}

export interface SanitizedError {
  name: string;
  message: string;
  /** True when the original message was replaced by a controlled description. */
  messageWithheld: boolean;
  stack?: string;
  code?: string | number;
  statusCode?: number;
  cause?: SanitizedError;
}

const MAX_CAUSE_DEPTH = 3;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : undefined;
}

function isAllowlistedMessage(error: Error): boolean {
  return error instanceof SafeMessageError || error instanceof ConfigError;
}

function stackFrames(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  const frames = stack.split('\n').filter((line) => /^\s+at\s/.test(line));
  return frames.length > 0 ? frames.join('\n') : undefined;
}

export function sanitizeError(error: unknown, depth = 0): SanitizedError {
  // Idempotent: an already-sanitized copy keeps its decision (and any allowlisted message).
  if (error instanceof SanitizedErrorCopy) return error.sanitized;
  if (!(error instanceof Error)) {
    // Non-Error throwables may be arbitrary strings or objects; record only their type.
    return {
      name: 'NonErrorThrown',
      message: `Non-error value of type ${typeof error} thrown (content withheld)`,
      messageWithheld: true,
    };
  }

  const name = safeIdentifier(error.name) ?? 'Error';
  const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
  const safeCode = typeof code === 'number' ? code : safeIdentifier(code);
  const allowlisted = isAllowlistedMessage(error);

  const sanitized: SanitizedError = {
    name,
    message: allowlisted
      ? redactSecrets(error.message)
      : `${name}${safeCode !== undefined ? ` [${safeCode}]` : ''}: message withheld by log policy`,
    messageWithheld: !allowlisted,
  };
  const frames = stackFrames(error.stack);
  if (frames !== undefined) sanitized.stack = frames;
  if (safeCode !== undefined) sanitized.code = safeCode;
  if (typeof statusCode === 'number') sanitized.statusCode = statusCode;
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    sanitized.cause = sanitizeError(error.cause, depth + 1);
  }
  return sanitized;
}

/**
 * A real Error rebuilt from sanitized fields only, so Sentry keeps type and stack grouping.
 * `sentry.ts` trusts messages of this class and withholds all others.
 */
export class SanitizedErrorCopy extends Error {
  readonly sanitized: SanitizedError;

  constructor(sanitized: SanitizedError) {
    super(sanitized.message);
    this.name = sanitized.name;
    this.sanitized = sanitized;
    this.stack = `${sanitized.name}: ${sanitized.message}${sanitized.stack !== undefined ? `\n${sanitized.stack}` : ''}`;
  }
}

export function toSafeError(error: unknown): SanitizedErrorCopy {
  if (error instanceof SanitizedErrorCopy) return error;
  return new SanitizedErrorCopy(sanitizeError(error));
}
