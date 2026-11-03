import type { GatewayEnv } from '@twring/config/gateway';
import type { FastifyLoggerOptions, FastifyRequest } from 'fastify';
import type { LoggerOptions } from 'pino';

import { safeUrl, sanitizeError } from './redact';

/**
 * Paths that must never reach logs. Fastify's default request serializer does not log headers,
 * but any future `log.info({ req })`-style call or custom serializer is covered too.
 */
/**
 * Field names whose values are secrets wherever they appear (SECURITY §16). Redaction paths are
 * case-sensitive, so header names are listed as Node receives them (lower case) and as Twring's own
 * provider adapters send them (`Authorization`, `X-API-Key`).
 */
const SECRET_FIELDS = [
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'apiKey',
  'api_key',
  'token', // includes a LiveKit join token (`livekit.token`)
  'access_token',
  'refresh_token',
  'secret',
  'password',
  'credential',
  // Self-hosted pairing (Global Constraints): never logged even if a call site names them.
  'device_token',
  'pairing_code',
  'admin_token',
  'server_seal_private_key',
  'relay_handle',
  // Self-hosted ring relay (Task 8).
  'relay_key',
  'ticket',
  'handle',
  'proof',
  'seal_key',
  // Call audio join tokens from the relay, and as the call audio hands them over.
  'caller_token',
  'server_token',
  'callerToken',
  'gatewayToken',
];

/** Header names with a hyphen, which need bracket paths. */
const SECRET_HEADERS = [
  'x-api-key',
  'X-API-Key',
  'X-Api-Key',
  'set-cookie',
  'Set-Cookie',
  'proxy-authorization',
  'Proxy-Authorization',
];

export const REDACTED_LOG_PATHS = [
  // A secret field or header at the top level or up to two objects deep.
  ...SECRET_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]),
  ...SECRET_HEADERS.flatMap((header) => [`["${header}"]`, `*["${header}"]`, `*.*["${header}"]`]),
];

/** Log fields that hold URLs: logged without their query string (tokens often ride there). */
const URL_FIELDS = ['url', 'endpoint', 'endpoint_url'];

/**
 * Path redaction only covers structured fields. Errors and URLs carry secrets in free text
 * (messages, stacks, `?token=` query params), so errors go through the redact.ts allowlist
 * policy and URLs are logged without their query string.
 */
export const LOG_SERIALIZERS = {
  // Idempotent: safe for raw errors and for errors already passed through toSafeError.
  err: (error: unknown) => {
    const { name, stack, ...rest } = sanitizeError(error);
    return { type: name, stack: stack ?? '', ...rest };
  },
  req: (req: FastifyRequest) => ({
    method: req.method,
    url: safeUrl(req.url),
    request_id: req.id,
  }),
  ...Object.fromEntries(
    URL_FIELDS.map((field) => [
      field,
      (value: unknown) => (typeof value === 'string' ? safeUrl(value) : value),
    ]),
  ),
};

/** Sees every log line of every logger made from createLoggerOptions (owner alerts). */
let logTap: ((level: number, fields: unknown) => void) | undefined;

export function setLogTap(tap: ((level: number, fields: unknown) => void) | undefined): void {
  logTap = tap;
}

export function createLoggerOptions(env: GatewayEnv): FastifyLoggerOptions & LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    base: { service: 'cord-gateway', environment: env.CORD_ENV, release: env.CORD_RELEASE },
    redact: { paths: REDACTED_LOG_PATHS, censor: '[REDACTED]' },
    serializers: LOG_SERIALIZERS,
    hooks: {
      logMethod(args, method, level) {
        const first: unknown = args[0];
        logTap?.(level, typeof first === 'object' && first !== null ? first : {});
        return method.apply(this, args);
      },
    },
  };
}
