import { ed25519 } from '@noble/curves/ed25519.js';
import {
  base64urlDecode,
  base64urlEncode,
  deriveSealKey,
  generateSealKeyPair,
  serverIdFor,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => new Uint8Array(n).map((_, i) => (i * 37 + 11) & 0xff),
  getRandomValues: <T>(a: T) => a,
}));
vi.mock('../auth/random-values', () => ({ installRandomValues: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import type { ProfileSecrets, SelfhostProfile } from './profiles';
import { pairWithServer, type PairDeps } from './pairing';

const NOW = 1_800_000_000_000;
const enc = (value: unknown) => base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
const CODE = 'ABCD-EFGH';
const NO_REACH = "Couldn't reach that server. Check the address, and that the server is running.";
const TOKEN = 'device-token-secret';

function makeServer() {
  const secret = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(secret);
  const seal = generateSealKeyPair();
  return { secret, id: serverIdFor(pub), publicKey: base64urlEncode(pub), seal };
}
type Srv = ReturnType<typeof makeServer>;

function info(s: Srv, nonce: string) {
  const head = enc({ alg: 'EdDSA', typ: 'JWT' });
  const payload = enc({
    aud: 'twring-app/server',
    server_id: s.id,
    nonce,
    iat: Math.floor(NOW / 1000),
  });
  const sig = ed25519.sign(new TextEncoder().encode(`${head}.${payload}`), s.secret);
  return {
    server_id: s.id,
    name: 'Home',
    mode: 'selfhost',
    audio: 'own',
    ring_service: { state: 'unknown' },
    public_key: s.publicKey,
    proof: `${head}.${payload}.${base64urlEncode(sig)}`,
  };
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function pairBody(s: Srv) {
  const { server_id, name, mode, audio, ring_service } = info(s, 'x');
  return {
    person: { id: 'p1', display_name: 'Sam', role: 'admin' },
    device: { id: 'd1', token: TOKEN },
    server: { server_id, name, mode, audio, ring_service },
    seal_server_public_key: base64urlEncode(s.seal.publicKey),
  };
}

interface Req {
  url: string;
  method: string;
  headers: Headers;
  body?: Record<string, unknown>;
}

const OLD: SelfhostProfile = {
  kind: 'selfhost',
  serverId: '',
  address: 'https://home.example.com',
  name: 'Home',
  publicKey: 'k',
  person: { id: 'p0', displayName: 'Sam', role: 'admin' },
  deviceId: 'old',
  audio: 'own',
};
const OLD_SECRETS: ProfileSecrets = { deviceToken: 'old-token', sealKey: 'old-seal' };

function setup(
  over: {
    pair?: () => Response;
    saveFails?: boolean;
    sealSetFails?: boolean;
    prior?: boolean;
  } = {},
) {
  const s = makeServer();
  const requests: Req[] = [];
  const saved: { profile: SelfhostProfile; secrets: ProfileSecrets }[] = [];
  const prior = over.prior ? { ...OLD, serverId: s.id } : undefined;
  let capturedPrivate: Uint8Array | undefined;
  const store = {
    list: vi.fn(() => (prior ? [prior] : [])),
    secrets: vi.fn(() => Promise.resolve(prior ? OLD_SECRETS : undefined)),
    save: vi.fn((profile: SelfhostProfile, secrets: ProfileSecrets) => {
      if (over.saveFails && profile.deviceId === 'd1') return Promise.reject(new Error('disk'));
      saved.push({ profile, secrets });
      return Promise.resolve();
    }),
    activate: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
  };
  const sealKeys = {
    set: vi.fn((_id: string, key: string) =>
      over.sealSetFails && key !== OLD_SECRETS.sealKey
        ? Promise.reject(new Error('native'))
        : Promise.resolve(),
    ),
    remove: vi.fn(() => Promise.resolve()),
    selfTest: vi.fn(() => Promise.resolve(true)),
  };
  const deps: PairDeps = {
    now: () => NOW,
    allowHttp: false,
    store,
    sealKeys,
    keyPair: () => {
      const kp = generateSealKeyPair();
      capturedPrivate = kp.privateKey;
      return kp;
    },
    fetch: (url, init) => {
      const u = new URL(url);
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      requests.push({
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body,
      });
      if (u.pathname === '/v1/server') {
        return Promise.resolve(json(info(s, u.searchParams.get('nonce') ?? '')));
      }
      if (u.pathname === '/v1/pair') {
        return Promise.resolve((over.pair ?? (() => json(pairBody(s), 201)))());
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  };
  return { s, deps, requests, saved, store, sealKeys, prior, privateKey: () => capturedPrivate };
}
const input = (over = {}) => ({
  address: 'https://home.example.com',
  code: CODE,
  displayName: '  Sam  ',
  ...over,
});
const errorBody = (code: string, message: string) => ({
  error: { code, message, request_id: 'r' },
});

describe('pairWithServer', () => {
  it('checks the server, pairs, and saves the profile and secrets', async () => {
    const t = setup();
    const out = await pairWithServer(input(), t.deps);
    expect(out.ok).toBe(true);
    expect(new URL(t.requests[0].url).pathname).toBe('/v1/server');
    const pair = t.requests[1];
    expect(pair.method).toBe('POST');
    expect(new URL(pair.url).pathname).toBe('/v1/pair');
    expect(Object.keys(pair.body ?? {}).sort()).toEqual(
      ['code', 'device_name', 'display_name', 'platform', 'seal_public_key'].sort(),
    );
    expect(pair.body).toMatchObject({
      code: CODE,
      display_name: 'Sam',
      device_name: 'Android phone',
      platform: 'android',
    });

    expect(t.saved).toHaveLength(1);
    const { profile, secrets } = t.saved[0];
    expect(profile).toMatchObject({
      kind: 'selfhost',
      serverId: t.s.id,
      address: 'https://home.example.com',
      name: 'Home',
      publicKey: t.s.publicKey,
      person: { id: 'p1', displayName: 'Sam', role: 'admin' },
      deviceId: 'd1',
      audio: 'own',
    });
    expect(secrets.deviceToken).toBe(TOKEN);
    const phonePublic = base64urlDecode(String(pair.body?.seal_public_key));
    const expectedKey = base64urlEncode(deriveSealKey(t.s.seal.privateKey, phonePublic));
    expect(secrets.sealKey).toBe(expectedKey);
    expect(t.sealKeys.set).toHaveBeenCalledWith(t.s.id, expectedKey);
    expect(t.store.activate).toHaveBeenCalledWith(t.s.id);
    expect(out.ok && out.profile).toEqual(profile);
    expect(JSON.stringify(profile)).not.toContain(expectedKey);
    expect(JSON.stringify(profile)).not.toContain(TOKEN);

    // The phone's seal private key is in no saved value, argument or outcome text.
    const priv = t.privateKey()!;
    for (const form of [
      base64urlEncode(priv),
      Array.from(priv, (b) => b.toString(16).padStart(2, '0')).join(''),
    ]) {
      expect(
        JSON.stringify([profile, secrets, t.sealKeys.set.mock.calls, t.store.save.mock.calls, out]),
      ).not.toContain(form);
    }
  });

  it('keeps the private key out of failure text too', async () => {
    const t = setup({ saveFails: true });
    const out = await pairWithServer(input(), t.deps);
    expect(JSON.stringify(out)).not.toContain(base64urlEncode(t.privateKey()!));
  });

  it('restores the old profile, secrets and seal key when a re-pair fails to save', async () => {
    for (const fail of [{ saveFails: true }, { sealSetFails: true }]) {
      const t = setup({ prior: true, ...fail });
      const out = await pairWithServer(input(), t.deps);
      expect(out).toEqual({ ok: false, message: NO_REACH, retryable: true });
      expect(t.store.remove).not.toHaveBeenCalled();
      expect(t.sealKeys.remove).not.toHaveBeenCalled();
      expect(t.store.save).toHaveBeenLastCalledWith(t.prior, OLD_SECRETS);
      expect(t.sealKeys.set).toHaveBeenLastCalledWith(t.s.id, OLD_SECRETS.sealKey);
      const del = t.requests.filter((r) => r.method === 'DELETE');
      expect(del).toHaveLength(1);
      expect(new URL(del[0].url).pathname).toBe('/v1/me/paired-devices/d1');
    }
  });

  it('removes the old phone after a successful re-pair, with the new token', async () => {
    const t = setup({ prior: true });
    const out = await pairWithServer(input(), t.deps);
    expect(out.ok).toBe(true);
    const del = t.requests.filter((r) => r.method === 'DELETE');
    expect(del).toHaveLength(1);
    expect(new URL(del[0].url).pathname).toBe('/v1/me/paired-devices/old');
    expect(del[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(t.saved[0].secrets.deviceToken).toBe(TOKEN);
  });

  it('still succeeds when removing the old phone fails', async () => {
    const t = setup({ prior: true });
    const base = t.deps.fetch;
    t.deps.fetch = (url, init) =>
      init?.method === 'DELETE' ? Promise.reject(new Error('net')) : base(url, init);
    expect((await pairWithServer(input(), t.deps)).ok).toBe(true);
  });

  it('times out when the answer body never arrives', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const base = t.deps.fetch;
      t.deps.fetch = (url, init) =>
        url.includes('/v1/pair')
          ? Promise.resolve({ status: 201, json: () => new Promise(() => undefined) } as Response)
          : base(url, init);
      const pending = pairWithServer(input(), t.deps);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await pending).toEqual({ ok: false, message: NO_REACH, retryable: true });
      expect(t.saved).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the server message for a bad code', async () => {
    const message = "That code didn't work. Ask for a new one.";
    const t = setup({ pair: () => json(errorBody('pairing_invalid', message), 400) });
    expect(await pairWithServer(input(), t.deps)).toEqual({ ok: false, message, retryable: false });
    expect(t.saved).toHaveLength(0);
  });

  it('caps a long server message', async () => {
    const t = setup({ pair: () => json(errorBody('pairing_invalid', 'x'.repeat(5_000)), 400) });
    const out = await pairWithServer(input(), t.deps);
    expect(out.ok === false && out.message.length).toBe(200);
  });

  it('follows no redirect on the pair and remove requests', async () => {
    const t = setup({ prior: true });
    const inits: (RequestInit | undefined)[] = [];
    const base = t.deps.fetch;
    t.deps.fetch = (url, init) => {
      inits.push(init);
      return base(url, init);
    };
    expect((await pairWithServer(input(), t.deps)).ok).toBe(true);
    expect(inits).toHaveLength(3);
    for (const init of inits) expect(init?.redirect).toBe('error');
  });

  it('shows the server message for rate limiting, retryable', async () => {
    const message = 'Too many tries. Wait a minute and try again.';
    const t = setup({ pair: () => json(errorBody('rate_limited', message), 429) });
    expect(await pairWithServer(input(), t.deps)).toEqual({ ok: false, message, retryable: true });
  });

  it('sends no pair request when the server check fails', async () => {
    const t = setup();
    t.deps.fetch = (url, init) => {
      t.requests.push({ url, method: init?.method ?? 'GET', headers: new Headers() });
      return Promise.reject(new Error('down'));
    };
    const out = await pairWithServer(input(), t.deps);
    expect(out).toEqual({ ok: false, message: NO_REACH, retryable: true });
    expect(t.requests.every((r) => !r.url.includes('/v1/pair'))).toBe(true);
  });

  it('saves nothing for a response that fails the schema', async () => {
    const t = setup({ pair: () => json({ hello: 'world' }, 201) });
    expect(await pairWithServer(input(), t.deps)).toEqual({
      ok: false,
      message: NO_REACH,
      retryable: true,
    });
    expect(t.saved).toHaveLength(0);
    expect(t.sealKeys.set).not.toHaveBeenCalled();
  });

  it('unpairs the new device when saving fails', async () => {
    const t = setup({ saveFails: true });
    const out = await pairWithServer(input(), t.deps);
    expect(out).toEqual({ ok: false, message: NO_REACH, retryable: true });
    const del = t.requests.find((r) => r.method === 'DELETE');
    expect(new URL(del?.url ?? 'x:').pathname).toBe('/v1/me/paired-devices/d1');
    expect(del?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(t.store.activate).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('rejects a bad display name before any request', async () => {
    for (const displayName of ['   ', 'x'.repeat(41)]) {
      const t = setup();
      const out = await pairWithServer(input({ displayName }), t.deps);
      expect(out.ok).toBe(false);
      expect(t.requests).toHaveLength(0);
    }
  });

  it('rejects a bad address before any request', async () => {
    const t = setup();
    const out = await pairWithServer(input({ address: 'http://home.example.com' }), t.deps);
    expect(out.ok).toBe(false);
    expect(t.requests).toHaveLength(0);
  });
});
