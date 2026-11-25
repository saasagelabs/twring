import { apiAuth } from '@/auth';
import { activeServerUrl } from '@/servers/active';

import { withAuth } from '../auth/controller';
import type { ApproveApi } from './approve';
import type { PairApi } from './pairing';
import type { RecoveryApi } from './recovery';
import type { RewrapApi } from './rewrap';

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
    claim: (offerId, body) => post(`/v1/e2e/pairings/${encodeURIComponent(offerId)}/claim`, body),
    // Only the typed code's first group: the rest never leaves the phone.
    lookup: (handle) => post('/v1/e2e/pairings/lookup', { handle }),
  };
}

/** The recovery backup calls (C3 #11); `recovery.ts` validates whatever comes back. */
export function recoveryApi(): RecoveryApi {
  return {
    get: () => request('GET', '/v1/e2e/recovery'),
    put: (body) => request('PUT', '/v1/e2e/recovery', body),
    remove: () => request('DELETE', '/v1/e2e/recovery'),
  };
}

/** Approving a second phone (C3 #11, Task 27); `approve.ts` validates whatever comes back. */
export function approveApi(): ApproveApi {
  const at = (id: string) => `/v1/e2e/approvals/${encodeURIComponent(id)}`;
  const as = (deviceId: string) => `device_id=${encodeURIComponent(deviceId)}`;
  return {
    request: (body) => post('/v1/e2e/approvals', body),
    status: (id, deviceId) => request('GET', `${at(id)}?${as(deviceId)}`),
    list: (deviceId) => request('GET', `/v1/e2e/approvals?${as(deviceId)}`),
    claim: (id, deviceId) => post(`${at(id)}/claim`, { device_id: deviceId }),
    accept: (id, deviceId, note) => post(`${at(id)}/accept`, { device_id: deviceId, note }),
    deny: (id, deviceId) => post(`${at(id)}/deny`, { device_id: deviceId }),
  };
}

/** Re-wrapped keys for a phone approved later (C3 #11, Task 28); `rewrap.ts` validates them. */
export function rewrapApi(): RewrapApi {
  const at = (agentId: string) => `/v1/agents/${encodeURIComponent(agentId)}/sealed-keys`;
  return {
    upload: (agentId, body) => post(at(agentId), body),
    read: (agentId, deviceId, after) =>
      request(
        'GET',
        `${at(agentId)}?device_id=${encodeURIComponent(deviceId)}${
          after === undefined ? '' : `&after=${encodeURIComponent(after)}`
        }`,
      ),
  };
}

const post = (path: string, body: unknown) => request('POST', path, body);

async function request(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const base = activeServerUrl().replace(/\/+$/, '');
  const send = async (headers: Record<string, string>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
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
}
