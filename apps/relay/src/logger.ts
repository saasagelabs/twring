import type { FastifyRequest } from 'fastify';
import type { LoggerOptions } from 'pino';

import type { RelayEnv } from './config';

/**
 * Field names whose values are secrets wherever they appear: relay keys, emails, link tokens,
 * device tickets, handles, push tokens and sealed envelopes.
 */
const SECRET_FIELDS = [
  'authorization',
  'Authorization',
  'cookie',
  'token',
  'secret',
  'password',
  'relay_key',
  'admin_token',
  'proof',
  'email',
  'public_key',
  'ticket',
  'handle',
  'fcm_token',
  'voip_token',
  'apns_token',
  'sealed',
];

export const REDACTED_LOG_PATHS = SECRET_FIELDS.flatMap((field) => [
  field,
  `*.${field}`,
  `*.*.${field}`,
]);

/** A URL without its query string (the email link carries its token there). */
export function safeUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : `${url.slice(0, cut)}?[query omitted]`;
}

export function createLoggerOptions(env: RelayEnv): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    base: { service: 'twring-relay', environment: env.RELAY_ENV },
    redact: { paths: REDACTED_LOG_PATHS, censor: '[REDACTED]' },
    serializers: {
      req: (req: FastifyRequest) => ({
        method: req.method,
        url: safeUrl(req.url),
        request_id: req.id,
      }),
      // Errors are logged by type only: messages can echo request content.
      err: (error: unknown) => ({
        type: error instanceof Error ? error.name : typeof error,
        code:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : undefined,
      }),
    },
  };
}
