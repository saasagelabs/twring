import { generateKeyPairSync } from 'node:crypto';

import {
  base64urlEncode,
  RELAY_INSTALL_PROOF_AUDIENCE,
  type RelayPushRequest,
} from '@twring/contracts';
import { importJWK, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import { serverIdentityFromKey } from './identity';
import {
  cachedRingService,
  onceAnHour,
  RelayAudioRefusedError,
  RelayClient,
  RelayUnavailableError,
  type RelayFetch,
} from './relay-client';

const identity = serverIdentityFromKey(generateKeyPairSync('ed25519').privateKey);
const RELAY_KEY = `twr_${'k'.repeat(43)}`;

interface Seen {
  url: string;
  init: RequestInit;
  body: unknown;
}

/** A relay that answers each request with the next scripted reply. */
function fakeRelay(replies: (() => Promise<Response> | Response)[]) {
  const seen: Seen[] = [];
  const fetch: RelayFetch = (url, init) => {
    seen.push({
      url,
      init,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const next = replies.shift();
    if (next === undefined) throw new Error('unexpected relay request');
    return Promise.resolve(next());
  };
  return { fetch, seen };
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function client(
  fetch: RelayFetch,
  extra: { timeoutMs?: number; allowInsecureAudio?: boolean } = {},
) {
  return new RelayClient({
    baseUrl: 'https://relay.example.test',
    relayKey: () => Promise.resolve(RELAY_KEY),
    fetch,
    retryDelayMs: 0,
    ...extra,
  });
}

const pushRequest: RelayPushRequest = {
  handle: 'hdl_abc',
  kind: 'ring',
  sealed: { v: 1, n: 'A'.repeat(32), c: 'B'.repeat(40) },
  ttl_seconds: 30,
  priority: 'high',
};

describe('RelayClient.push', () => {
  it('posts to the relay with the relay key, no redirects, and a time limit', async () => {
    const relay = fakeRelay([json(200, { outcome: 'sent' })]);
    expect(await client(relay.fetch).push(pushRequest)).toBe('sent');
    expect(relay.seen).toHaveLength(1);
    const [call] = relay.seen;
    expect(call!.url).toBe('https://relay.example.test/v1/push');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.redirect).toBe('error');
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);
    expect((call!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${RELAY_KEY}`,
    );
    expect(call!.body).toEqual(pushRequest);
  });

  it('a 404 invalid answer is reported as invalid, without a retry', async () => {
    const relay = fakeRelay([json(404, { outcome: 'invalid' })]);
    expect(await client(relay.fetch).push(pushRequest)).toBe('invalid');
    expect(relay.seen).toHaveLength(1);
  });

  it.each([
    ['unsupported', 200],
    ['limited', 429],
    ['paused', 200],
    ['expired', 200],
  ] as const)('%s is never retried', async (outcome, status) => {
    const relay = fakeRelay([json(status, { outcome }), json(200, { outcome: 'sent' })]);
    expect(await client(relay.fetch).push(pushRequest)).toBe(outcome);
    expect(relay.seen).toHaveLength(1);
  });

  it('a 503 is retried once, then reported failed', async () => {
    const relay = fakeRelay([
      json(503, { error: { code: 'service_unavailable' } }),
      json(503, { error: { code: 'service_unavailable' } }),
      json(200, { outcome: 'sent' }),
    ]);
    expect(await client(relay.fetch).push(pushRequest)).toBe('failed');
    expect(relay.seen).toHaveLength(2);
  });

  it('a 503 then success counts as sent', async () => {
    const relay = fakeRelay([json(503, {}), json(200, { outcome: 'sent' })]);
    expect(await client(relay.fetch).push(pushRequest)).toBe('sent');
    expect(relay.seen).toHaveLength(2);
  });

  it('a relay that never answers times out and is reported failed', async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    let calls = 0;
    const fetch: RelayFetch = (url, init) => {
      calls += 1;
      return hang(url, init);
    };
    expect(await client(fetch, { timeoutMs: 20 }).push(pushRequest)).toBe('failed');
    expect(calls).toBe(2);
  });

  it('a garbled answer is failed, not thrown', async () => {
    const relay = fakeRelay([() => new Response('<html>', { status: 200 })]);
    expect(await client(relay.fetch).push(pushRequest)).toBe('failed');
  });
});

const SESSION = {
  room: 'inst_ins_A_call_b',
  caller_token: 'caller.jwt',
  server_token: 'server.jwt',
  expires_at: '2027-01-01T02:00:00.000Z',
};

describe('RelayClient audio sessions', () => {
  it('asks for a session with the call id and returns it', async () => {
    const relay = fakeRelay([json(201, { url: 'wss://audio.twring.test', ...SESSION })]);
    const session = await client(relay.fetch).audioSession('call_b');
    expect(session.url).toBe('wss://audio.twring.test');
    expect(relay.seen[0]!.url).toBe('https://relay.example.test/v1/audio/sessions');
    expect(relay.seen[0]!.init.method).toBe('POST');
    expect(relay.seen[0]!.body).toEqual({ call_id: 'call_b' });
  });

  it('refuses a plain ws:// address outside development', async () => {
    const relay = fakeRelay([json(201, { url: 'ws://audio.twring.test', ...SESSION })]);
    await expect(client(relay.fetch).audioSession('call_b')).rejects.toThrow(
      /could not be reached/,
    );
  });

  it('accepts ws:// only when development allows it', async () => {
    const relay = fakeRelay([json(201, { url: 'ws://localhost:7880', ...SESSION })]);
    const session = await client(relay.fetch, { allowInsecureAudio: true }).audioSession('call_b');
    expect(session.url).toBe('ws://localhost:7880');
  });

  it.each([
    [403, 'audio_paused'],
    [403, 'audio_expired'],
    [429, 'audio_limit_reached'],
  ] as const)('a %s %s refusal is reported as that refusal', async (status, code) => {
    const relay = fakeRelay([json(status, { error: { code, message: 'x' } })]);
    const error = await client(relay.fetch)
      .audioSession('call_b')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayAudioRefusedError);
    expect((error as RelayAudioRefusedError).code).toBe(code);
  });

  it('any other refusal, a 5xx or a bad key is unavailable', async () => {
    for (const reply of [
      json(503, { error: { code: 'service_unavailable', message: 'x' } }),
      json(401, { error: { code: 'auth_invalid', message: 'x' } }),
      json(429, { error: { code: 'rate_limited', message: 'x' } }),
    ]) {
      const relay = fakeRelay([reply]);
      await expect(client(relay.fetch).audioSession('call_b')).rejects.toBeInstanceOf(
        RelayUnavailableError,
      );
    }
  });

  it('ends a session by its call id', async () => {
    const relay = fakeRelay([() => new Response(null, { status: 204 })]);
    await client(relay.fetch).endAudioSessionByCall('call_b');
    expect(relay.seen[0]!.url).toBe('https://relay.example.test/v1/audio/sessions/by-call/call_b');
    expect(relay.seen[0]!.init.method).toBe('DELETE');
  });

  it('ends a session by its room', async () => {
    const relay = fakeRelay([() => new Response(null, { status: 204 })]);
    await client(relay.fetch).endAudioSession('inst_ins_A_call_b');
    expect(relay.seen[0]!.url).toBe(
      'https://relay.example.test/v1/audio/sessions/inst_ins_A_call_b',
    );
    expect(relay.seen[0]!.init.method).toBe('DELETE');
  });
});

describe('RelayClient.registerInstall', () => {
  it('signs a fresh single-use proof over email, news and address with the server key', async () => {
    const answer = {
      install_id: 'inst_1',
      relay_key: RELAY_KEY,
      paid_until: '2027-06-01T00:00:00.000Z',
      verified: false,
    };
    const relay = fakeRelay([json(201, answer), json(201, answer)]);
    const relayClient = new RelayClient({
      baseUrl: 'https://relay.example.test',
      // Registration works before any relay key exists.
      relayKey: () => Promise.reject(new Error('no key yet')),
      fetch: relay.fetch,
    });
    const request = { email: 'owner@example.com', news: true, address: 'home.example.com' };
    const nowMs = Date.parse('2026-10-29T10:00:00.000Z');
    expect(await relayClient.registerInstall(request, identity, nowMs)).toEqual(answer);
    await relayClient.registerInstall(request, identity, nowMs);

    const [first, second] = relay.seen as [Seen, Seen];
    expect(first.url).toBe('https://relay.example.test/v1/installs');
    expect(first.init.redirect).toBe('error');
    expect((first.init.headers as Record<string, string>).authorization).toBeUndefined();
    const body = first.body as Record<string, unknown>;
    expect(body).toMatchObject({
      email: 'owner@example.com',
      news: true,
      address: 'home.example.com',
      server_id: identity.id,
      public_key: base64urlEncode(identity.publicKeyRaw),
    });
    const key = await importJWK(
      { kty: 'OKP', crv: 'Ed25519', x: base64urlEncode(identity.publicKeyRaw) },
      'EdDSA',
    );
    const { payload } = await jwtVerify(body.proof as string, key, {
      audience: RELAY_INSTALL_PROOF_AUDIENCE,
      currentDate: new Date(nowMs),
    });
    expect(payload).toMatchObject({
      server_id: identity.id,
      email: 'owner@example.com',
      news: true,
      address: 'home.example.com',
      iat: nowMs / 1000,
      exp: nowMs / 1000 + 540,
    });
    expect(payload.jti!.length).toBeGreaterThanOrEqual(16);
    expect(payload.jti!.length).toBeLessThanOrEqual(128);
    const secondProof = (second.body as Record<string, unknown>).proof as string;
    const again = await jwtVerify(secondProof, key, { currentDate: new Date(nowMs) });
    expect(again.payload.jti).not.toBe(payload.jti);
  });

  it('a refused registration throws without the relay answer in the message', async () => {
    const relay = fakeRelay([json(409, { error: { code: 'invalid_request' } })]);
    await expect(
      client(relay.fetch).registerInstall({ email: 'a@example.com', news: false }, identity),
    ).rejects.toThrow(/409/);
  });
});

describe('cachedRingService', () => {
  const status = (state: string) =>
    json(200, { state, paid_until: '2027-06-01T00:00:00.000Z', verified: state !== 'unverified' });

  it.each(['unverified', 'paused', 'expired', 'active'])('shows %s from the relay', async (s) => {
    const relay = fakeRelay([status(s)]);
    const ring = cachedRingService(client(relay.fetch));
    expect(await ring.provider()).toEqual({ state: s, paid_until: '2027-06-01T00:00:00.000Z' });
  });

  it('caches for 10 minutes', async () => {
    const relay = fakeRelay([status('active'), status('paused')]);
    let now = 0;
    const ring = cachedRingService(client(relay.fetch), { now: () => now });
    expect((await ring.provider()).state).toBe('active');
    now = 9 * 60_000;
    expect((await ring.provider()).state).toBe('active');
    expect(relay.seen).toHaveLength(1);
    now = 10 * 60_000 + 1;
    expect((await ring.provider()).state).toBe('paused');
    expect(relay.seen).toHaveLength(2);
  });

  it('keeps the last known state when the relay times out', async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    let first = true;
    const fetch: RelayFetch = (url, init) => {
      if (first) {
        first = false;
        return Promise.resolve(status('unverified')());
      }
      return hang(url, init);
    };
    let now = 0;
    const ring = cachedRingService(client(fetch, { timeoutMs: 20 }), { now: () => now });
    expect((await ring.provider()).state).toBe('unverified');
    now = 11 * 60_000;
    expect(await ring.provider()).toEqual({
      state: 'unverified',
      paid_until: '2027-06-01T00:00:00.000Z',
    });
  });

  it('before the relay ever answered the state is unknown, with no paid_until', async () => {
    const relay = fakeRelay([json(503, {})]);
    const ring = cachedRingService(client(relay.fetch));
    expect(await ring.provider()).toEqual({ state: 'unknown' });
    ring.record('paused');
    expect(await ring.provider()).toEqual({ state: 'unknown' });
  });

  it('records paused or expired learned from a push', async () => {
    const relay = fakeRelay([status('active')]);
    const ring = cachedRingService(client(relay.fetch));
    await ring.provider();
    ring.record('expired');
    expect((await ring.provider()).state).toBe('expired');
  });
});

describe('a server whose registration is gone', () => {
  const unauthorized = json(401, { error: { code: 'unauthorized', message: 'Unknown key.' } });

  it('the client reports a 401 from any relay call', async () => {
    let told = 0;
    const relay = fakeRelay([unauthorized, unauthorized]);
    const c = new RelayClient({
      baseUrl: 'https://relay.example.test',
      relayKey: () => Promise.resolve(RELAY_KEY),
      fetch: relay.fetch,
      retryDelayMs: 0,
      onUnregistered: () => {
        told += 1;
      },
    });
    await expect(c.status()).rejects.toThrow();
    await c.push(pushRequest).catch(() => undefined);
    expect(told).toBe(2);
  });

  it('the ring service shows unregistered, and active again once registered', async () => {
    const relay = fakeRelay([
      unauthorized,
      json(200, { state: 'active', paid_until: '2027-06-01T00:00:00.000Z', verified: true }),
    ]);
    let now = 0;
    const ring = cachedRingService(client(relay.fetch), { now: () => now });
    expect(await ring.provider()).toEqual({ state: 'unregistered' });
    now = 10 * 60_000 + 1;
    expect((await ring.provider()).state).toBe('active');
  });

  it('a 401 seen elsewhere marks the ring service unregistered', async () => {
    const relay = fakeRelay([
      json(200, { state: 'active', paid_until: '2027-06-01T00:00:00.000Z', verified: true }),
    ]);
    const ring = cachedRingService(client(relay.fetch), { now: () => 0 });
    expect((await ring.provider()).state).toBe('active');
    ring.unregistered();
    expect(await ring.provider()).toEqual({ state: 'unregistered' });
  });

  it('warns at most once an hour', () => {
    let now = 0;
    const lines: string[] = [];
    const warn = onceAnHour(
      (line) => lines.push(line),
      () => now,
    );
    warn('gone');
    now = 59 * 60_000;
    warn('gone');
    now = 60 * 60_000 + 1;
    warn('gone');
    expect(lines).toEqual(['gone', 'gone']);
  });
});
