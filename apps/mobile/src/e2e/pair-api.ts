import { apiAuth } from '@/auth';
import { activeServerUrl } from '@/servers/active';

import { withAuth } from '../auth/controller';
import type { PairApi } from './pairing';

const TIMEOUT_MS = 15_000;
const AUTH_CODES = ['auth_invalid', 'auth_required', 'device_removed'] as const;
type AuthCode = (typeof AUTH_CODES)[number];

/** An answer refusing the sign-in, thrown so `withAuth` can refresh and retry once. */
class AuthRefused extends Error {
  constructor(
    readonly code: AuthCode,
    readonly answer: { status: number; body: unknown },
  ) {
    super(code);
  }
}

function authCodeIn(body: unknown): AuthCode | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return AUTH_CODES.find((c) => c === code);
}

/**
 * The signed-in phone's claim call; `pairing.ts` validates whatever comes back. It goes through
 * the app's `withAuth`, so an expired sign-in refreshes and retries once instead of failing.
 */
export function pairApi(): PairApi {
  return {
    async claim(offerId, body) {
      const base = activeServerUrl().replace(/\/+$/, '');
      const send = async (headers: Record<string, string>) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await fetch(`${base}/v1/e2e/pairings/${encodeURIComponent(offerId)}/claim`, {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              ...headers,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          const json: unknown = await res.json().catch(() => undefined);
          const answer = { status: res.status, body: json };
          const code = res.status === 401 || res.status === 403 ? authCodeIn(json) : undefined;
          if (code !== undefined) throw new AuthRefused(code, answer);
          return answer;
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        return await withAuth(apiAuth(), send, (error) =>
          error instanceof AuthRefused ? error.code : undefined,
        );
      } catch (error) {
        if (error instanceof AuthRefused) return error.answer;
        throw error;
      }
    },
  };
}
