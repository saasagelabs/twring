import { apiAuth } from '@/auth';
import { activeServerUrl } from '@/servers/active';

import type { PairApi } from './pairing';

const TIMEOUT_MS = 15_000;

/** The signed-in phone's claim call; `pairing.ts` validates whatever comes back. */
export function pairApi(): PairApi {
  return {
    async claim(offerId, body) {
      const base = activeServerUrl().replace(/\/+$/, '');
      const token = apiAuth()?.token();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/v1/e2e/pairings/${encodeURIComponent(offerId)}/claim`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(token !== undefined && { authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const json: unknown = await res.json().catch(() => undefined);
        return { status: res.status, body: json };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
