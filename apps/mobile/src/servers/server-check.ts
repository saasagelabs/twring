import {
  base64urlEncode,
  serverInfoSchema,
  serverNonceSchema,
  verifyServerProof,
  type ServerInfo,
} from '@twring/contracts';
import { getRandomBytes } from 'expo-crypto';

import { installRandomValues } from '../auth/random-values';

import { normalizeAddress } from './address';

export type ServerCheckResult =
  | { ok: true; info: ServerInfo; publicKey: string }
  | {
      ok: false;
      reason: 'unreachable' | 'not_twring' | 'wrong_server' | 'changed';
      message: string;
    };

export interface CheckDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  nonce?: () => string;
  /** True only in development builds: lets `address` be http://. */
  allowHttp?: boolean;
}

const TIMEOUT_MS = 8_000;

const MESSAGES = {
  unreachable: "Couldn't reach that server. Check the address, and that the server is running.",
  not_twring: "Couldn't reach that server. Check the address, and that the server is running.",
  wrong_server: "This isn't the server that printed the code. Check the address.",
  changed: 'This address now answers as a different server. Pair this phone again with a new code.',
} as const;

function fail(reason: keyof typeof MESSAGES): ServerCheckResult {
  return { ok: false, reason, message: MESSAGES[reason] };
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

const defaultNonce = () => base64urlEncode(getRandomBytes(16));

/**
 * Asks `address` who it is and verifies the answer's signature before the app sends it anything
 * secret. The request carries only a fresh nonce (no credentials). `expected.serverId` is what a
 * QR or a saved server named; without it the id the server proves is trusted (it must still match
 * its key) and the key is returned so it can be pinned. With `expected.publicKey` (a saved
 * server) a different key is `changed`. The address must pass the same gate as a typed one, and
 * an answer from anywhere else (a redirect) is refused: a host must not relay another server's
 * proof.
 */
export async function checkServer(
  address: string,
  expected: { serverId?: string; publicKey?: string },
  deps: CheckDeps,
): Promise<ServerCheckResult> {
  const normalized = normalizeAddress(address, { allowHttp: deps.allowHttp ?? false });
  if (!normalized.ok) return fail('unreachable');
  installRandomValues();
  const nonce = (deps.nonce ?? defaultNonce)();
  if (!serverNonceSchema.safeParse(nonce).success) return fail('unreachable');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let body: unknown;
  try {
    const url = `${normalized.address}/v1/server?nonce=${nonce}`;
    const res = await deps.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    // Where fetch reports the final address, it must be the one asked.
    if (typeof res.url === 'string' && res.url !== '' && !sameUrl(res.url, url)) {
      return fail('not_twring');
    }
    if (res.status >= 500) return fail('unreachable');
    if (!res.ok) return fail('not_twring');
    body = await res.json();
  } catch (err) {
    // A body that is not JSON is not a Twring server; everything else is a network problem.
    return fail(err instanceof SyntaxError ? 'not_twring' : 'unreachable');
  } finally {
    clearTimeout(timer);
  }

  const parsed = serverInfoSchema.safeParse(body);
  if (!parsed.success || parsed.data.public_key === undefined) return fail('not_twring');
  const info = parsed.data;
  const publicKey = info.public_key!;

  const proof = verifyServerProof(info, { nonce, nowMs: deps.now(), serverId: info.server_id });
  if (!proof.ok) return fail('not_twring');

  if (expected.serverId !== undefined && expected.serverId !== info.server_id) {
    // A saved server (pinned key) that now answers as another id changed; a QR mismatch is wrong.
    return fail(expected.publicKey !== undefined ? 'changed' : 'wrong_server');
  }
  if (expected.publicKey !== undefined && expected.publicKey !== publicKey) return fail('changed');
  return { ok: true, info, publicKey };
}
