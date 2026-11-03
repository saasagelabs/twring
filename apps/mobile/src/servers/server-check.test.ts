import { ed25519 } from '@noble/curves/ed25519.js';
import { base64urlEncode, serverIdFor } from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => new Uint8Array(n).map((_, i) => (i * 37 + 11) & 0xff),
  getRandomValues: <T>(a: T) => a,
}));

vi.mock('../auth/random-values', () => ({ installRandomValues: vi.fn() }));

import { checkServer, type CheckDeps } from './server-check';

const NOW = 1_800_000_000_000;
const enc = (value: unknown) => base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));

function makeServer() {
  const secret = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(secret);
  return { secret, pub, id: serverIdFor(pub), publicKey: base64urlEncode(pub) };
}
type Srv = ReturnType<typeof makeServer>;

function proof(s: Srv, nonce: string, over: { iat?: number; signer?: Uint8Array } = {}) {
  const head = enc({ alg: 'EdDSA', typ: 'JWT' });
  const payload = enc({
    aud: 'twring-app/server',
    server_id: s.id,
    nonce,
    iat: over.iat ?? Math.floor(NOW / 1000),
  });
  const sig = ed25519.sign(new TextEncoder().encode(`${head}.${payload}`), over.signer ?? s.secret);
  return `${head}.${payload}.${base64urlEncode(sig)}`;
}

function body(s: Srv, nonce: string, extra: Record<string, unknown> = {}) {
  return {
    server_id: s.id,
    name: 'Home',
    mode: 'selfhost',
    audio: 'own',
    ring_service: { state: 'unknown' },
    public_key: s.publicKey,
    proof: proof(s, nonce),
    ...extra,
  };
}

function deps(answer: (nonce: string) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const d: CheckDeps = {
    now: () => NOW,
    nonce: () => 'AAAAAAAAAAAAAAAAAAAAAA',
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(answer(new URL(url).searchParams.get('nonce') ?? ''));
    },
  };
  return { d, calls };
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const unreachable = {
  ok: false,
  reason: 'unreachable',
  message: "Couldn't reach that server. Check the address, and that the server is running.",
};

afterEach(() => vi.useRealTimers());

describe('checkServer', () => {
  it('passes a good proof and returns the key', async () => {
    const s = makeServer();
    const { d, calls } = deps((n) => json(body(s, n)));
    const r = await checkServer('https://h.example.com', {}, d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.publicKey).toBe(s.publicKey);
      expect(r.info.server_id).toBe(s.id);
    }
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://h.example.com/v1/server');
    expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect([...url.searchParams.keys()]).toEqual(['nonce']);
    expect(new Headers(calls[0].init?.headers).has('authorization')).toBe(false);
  });

  it('makes a valid nonce with the default generator', async () => {
    const s = makeServer();
    let seen = '';
    const { d } = deps((n) => {
      seen = n;
      return json(body(s, n));
    });
    const r = await checkServer('https://h', {}, { fetch: d.fetch, now: d.now });
    expect(r.ok).toBe(true);
    expect(seen).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it('refuses a QR id mismatch as wrong_server', async () => {
    const s = makeServer();
    const other = makeServer();
    const { d } = deps((n) => json(body(s, n)));
    expect(await checkServer('https://h', { serverId: other.id }, d)).toEqual({
      ok: false,
      reason: 'wrong_server',
      message: "This isn't the server that printed the code. Check the address.",
    });
  });

  it('refuses a proof signed by another key', async () => {
    const s = makeServer();
    const evil = makeServer();
    const { d } = deps((n) => json(body(s, n, { proof: proof(s, n, { signer: evil.secret }) })));
    expect((await checkServer('https://h', {}, d)).ok).toBe(false);
  });

  it('refuses a proof over another nonce', async () => {
    const s = makeServer();
    const { d } = deps(() => json(body(s, 'BBBBBBBBBBBBBBBBBBBBBB')));
    expect((await checkServer('https://h', {}, d)).ok).toBe(false);
  });

  it('refuses iat 6 minutes off', async () => {
    const s = makeServer();
    const { d } = deps((n) =>
      json(body(s, n, { proof: proof(s, n, { iat: Math.floor(NOW / 1000) - 360 }) })),
    );
    expect((await checkServer('https://h', {}, d)).ok).toBe(false);
  });

  it('refuses a public key whose id differs', async () => {
    const s = makeServer();
    const other = makeServer();
    const { d } = deps((n) => json(body(s, n, { public_key: other.publicKey })));
    expect((await checkServer('https://h', {}, d)).ok).toBe(false);
  });

  it('reports changed when the pinned key differs', async () => {
    const s = makeServer();
    const other = makeServer();
    const { d } = deps((n) => json(body(s, n)));
    expect(
      await checkServer('https://h', { serverId: s.id, publicKey: other.publicKey }, d),
    ).toEqual({
      ok: false,
      reason: 'changed',
      message:
        'This address now answers as a different server. Pair this phone again with a new code.',
    });
  });

  it('reports changed when a saved server answers as another id', async () => {
    const s = makeServer();
    const other = makeServer();
    const { d } = deps((n) => json(body(s, n)));
    const r = await checkServer('https://h', { serverId: other.id, publicKey: other.publicKey }, d);
    expect(r.ok === false && r.reason).toBe('changed');
  });

  it('passes with a matching pinned key', async () => {
    const s = makeServer();
    const { d } = deps((n) => json(body(s, n)));
    expect((await checkServer('https://h', { serverId: s.id, publicKey: s.publicKey }, d)).ok).toBe(
      true,
    );
  });

  it('is unreachable on a 500', async () => {
    const { d } = deps(() => new Response('boom', { status: 500 }));
    expect(await checkServer('https://h', {}, d)).toEqual(unreachable);
  });

  it('is unreachable when fetch throws', async () => {
    const d: CheckDeps = {
      now: () => NOW,
      nonce: () => 'AAAAAAAAAAAAAAAAAAAAAA',
      fetch: () => Promise.reject(new Error('down')),
    };
    expect(await checkServer('https://h', {}, d)).toEqual(unreachable);
  });

  it('times out after 8 seconds', async () => {
    vi.useFakeTimers();
    const d: CheckDeps = {
      now: () => NOW,
      nonce: () => 'AAAAAAAAAAAAAAAAAAAAAA',
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    let done = false;
    const pending = checkServer('https://h', {}, d).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toEqual(unreachable);
  });

  it('treats a 404 (hosted Twring address) as not_twring', async () => {
    const { d } = deps(() => new Response('nope', { status: 404 }));
    expect(await checkServer('https://h', {}, d)).toEqual({
      ok: false,
      reason: 'not_twring',
      message: "Couldn't reach that server. Check the address, and that the server is running.",
    });
  });

  it('treats non-JSON and wrong mode as not_twring', async () => {
    const s = makeServer();
    const a = deps(() => new Response('<html>', { status: 200 }));
    const ra = await checkServer('https://h', {}, a.d);
    expect(ra.ok === false && ra.reason).toBe('not_twring');
    const b = deps((n) => json(body(s, n, { mode: 'hosted' })));
    const rb = await checkServer('https://h', {}, b.d);
    expect(rb.ok === false && rb.reason).toBe('not_twring');
  });

  it('treats a missing proof as not_twring', async () => {
    const s = makeServer();
    const { d } = deps((n) => {
      const rest: Record<string, unknown> = body(s, n);
      delete rest.proof;
      return json(rest);
    });
    const r = await checkServer('https://h', {}, d);
    expect(r.ok === false && r.reason).toBe('not_twring');
  });

  it('refuses redirects and sends the nonce only to the requested address', async () => {
    const s = makeServer();
    const { d, calls } = deps((n) => json(body(s, n)));
    expect((await checkServer('https://h.example.com', {}, d)).ok).toBe(true);
    expect(calls[0].init?.redirect).toBe('error');
  });

  it('refuses an answer that came from another address', async () => {
    const s = makeServer();
    const { d } = deps((n) => {
      const res = json(body(s, n));
      Object.defineProperty(res, 'url', { value: `https://real.example.com/v1/server?nonce=${n}` });
      return res;
    });
    const r = await checkServer('https://h.example.com', {}, d);
    expect(r.ok).toBe(false);
  });

  it('passes an answer whose url is the requested one', async () => {
    const s = makeServer();
    const { d } = deps((n) => {
      const res = json(body(s, n));
      Object.defineProperty(res, 'url', { value: `https://h.example.com/v1/server?nonce=${n}` });
      return res;
    });
    expect((await checkServer('https://h.example.com', {}, d)).ok).toBe(true);
  });

  it('refuses an address that is not a server address, without asking anyone', async () => {
    const s = makeServer();
    const { d, calls } = deps((n) => json(body(s, n)));
    expect(await checkServer('https://evil.example.com/x?y=', {}, d)).toEqual(unreachable);
    expect(await checkServer('http://h.example.com', {}, d)).toEqual(unreachable);
    expect(calls).toHaveLength(0);
  });

  it('allows http only when allowed (development)', async () => {
    const s = makeServer();
    const { d, calls } = deps((n) => json(body(s, n)));
    expect((await checkServer('http://h.example.com', {}, { ...d, allowHttp: true })).ok).toBe(
      true,
    );
    expect(calls[0].url.startsWith('http://h.example.com/v1/server?')).toBe(true);
  });
});
