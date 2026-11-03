import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { buildPairLink } from '@twring/contracts';

import { runAdminCli } from './admin-cli';
import type { RelayFetch } from './selfhost/relay-client';

const RELAY_KEY = `twr_${'k'.repeat(43)}`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'admin-cli-'));
  const serverKeyFile = join(dir, 'server-key.pem');
  writeFileSync(
    serverKeyFile,
    generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }),
  );
  const relayKeyFile = join(dir, 'relay-key');
  const env = {
    TWRING_RELAY_URL: 'https://relay.test',
    TWRING_SERVER_KEY_FILE: serverKeyFile,
    TWRING_RELAY_KEY_FILE: relayKeyFile,
  };
  return { dir, env, relayKeyFile };
}

function fakeRelay(reply: (url: string, init: RequestInit) => Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  const relayFetch: RelayFetch = (url, init) => {
    seen.push({ url, init });
    return Promise.resolve(reply(url, init));
  };
  return { relayFetch, seen };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function run(argv: string[], env: Record<string, string>, relayFetch: RelayFetch) {
  const out: string[] = [];
  const code = await runAdminCli(argv, {
    token: undefined,
    env,
    relayFetch,
    out: (text) => out.push(text),
  });
  return { code, text: out.join('\n') };
}

describe('admin-cli offline commands', () => {
  it('ip asks the relay without a key', async () => {
    const { env } = setup();
    const relay = fakeRelay(() => json(200, { ip: '203.0.113.7' }));
    const { code, text } = await run(['ip'], env, relay.relayFetch);
    expect(code).toBe(0);
    expect(text).toBe('203.0.113.7');
    expect(relay.seen[0]!.url).toBe('https://relay.test/v1/ip');
    expect((relay.seen[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('register signs a fresh proof and stores the relay key, mode 600, never printed', async () => {
    const { env, relayKeyFile } = setup();
    const relay = fakeRelay(() =>
      json(201, {
        install_id: 'inst_1',
        relay_key: RELAY_KEY,
        paid_until: '2027-01-01T00:00:00.000Z',
        verified: false,
      }),
    );
    const { code, text } = await run(
      ['register', '--email', 'a@example.com', '--news', 'no', '--address', '203-0-113-7.sslip.io'],
      env,
      relay.relayFetch,
    );
    expect(code).toBe(0);
    expect(text).not.toContain(RELAY_KEY);
    expect(text).toContain('inst_1');
    expect(readFileSync(relayKeyFile, 'utf8').trim()).toBe(RELAY_KEY);
    if (process.platform !== 'win32') expect(statSync(relayKeyFile).mode & 0o777).toBe(0o600);
    const body = JSON.parse(relay.seen[0]!.init.body as string) as Record<string, unknown>;
    expect(relay.seen[0]!.url).toBe('https://relay.test/v1/installs');
    expect(body).toMatchObject({ email: 'a@example.com', news: false });
    const claims = decodeJwt(body.proof as string);
    expect(typeof claims.jti).toBe('string');
    expect(claims.exp! - claims.iat!).toBe(540);
  });

  it('register refuses bad input and leaves no key when the relay refuses', async () => {
    const { env, relayKeyFile } = setup();
    const relay = fakeRelay(() => json(409, { error: { code: 'conflict', message: 'no' } }));
    expect((await run(['register', '--email', 'a@b.c'], env, relay.relayFetch)).code).toBe(2);
    const refused = await run(
      ['register', '--email', 'a@b.c', '--news', 'yes'],
      env,
      relay.relayFetch,
    );
    expect(refused.code).toBe(3);
    expect(() => readFileSync(relayKeyFile)).toThrow();
  });

  it('address sets the probe address with the relay key', async () => {
    const { env, relayKeyFile } = setup();
    writeFileSync(relayKeyFile, `${RELAY_KEY}\n`);
    const relay = fakeRelay(() => json(200, { address: 'home.example.com' }));
    const { code } = await run(['address', 'home.example.com'], env, relay.relayFetch);
    expect(code).toBe(0);
    expect(relay.seen[0]!.init.method).toBe('PUT');
    expect((relay.seen[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${RELAY_KEY}`,
    );
  });

  it('unregister deletes the install at the relay with the relay key', async () => {
    const { env, relayKeyFile } = setup();
    writeFileSync(
      relayKeyFile,
      `${RELAY_KEY}
`,
    );
    const relay = fakeRelay(() => new Response(null, { status: 204 }));
    const { code } = await run(['unregister'], env, relay.relayFetch);
    expect(code).toBe(0);
    expect(relay.seen[0]!.init.method).toBe('DELETE');
    expect(relay.seen[0]!.url).toMatch(/\/v1\/installs\/self$/);
    expect((relay.seen[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${RELAY_KEY}`,
    );
  });

  it('unregister counts an install the relay no longer knows as done, and fails otherwise', async () => {
    const { env, relayKeyFile } = setup();
    writeFileSync(
      relayKeyFile,
      `${RELAY_KEY}
`,
    );
    const gone = fakeRelay(() => json(401, { error: { code: 'unauthorized', message: 'x' } }));
    expect((await run(['unregister'], env, gone.relayFetch)).code).toBe(0);
    const down = fakeRelay(() => new Response(null, { status: 503 }));
    expect((await run(['unregister'], env, down.relayFetch)).code).not.toBe(0);
  });

  it('probe prints the results as JSON and rejects unknown checks', async () => {
    const { env, relayKeyFile } = setup();
    writeFileSync(relayKeyFile, `${RELAY_KEY}\n`);
    const relay = fakeRelay(() =>
      json(200, { results: { tcp7881: { ok: true }, udp7882: { ok: false } } }),
    );
    const { code, text } = await run(
      ['probe', '--address', 'home.example.com', '--checks', 'tcp7881,udp7882'],
      env,
      relay.relayFetch,
    );
    expect(code).toBe(0);
    expect(text).toBe('{"tcp7881":{"ok":true},"udp7882":{"ok":false}}');
    const body = JSON.parse(relay.seen[0]!.init.body as string) as { nonce: string };
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(
      (await run(['probe', '--address', 'a', '--checks', 'ssh'], env, relay.relayFetch)).code,
    ).toBe(2);
  });

  it('a missing relay key file fails without a stack or key', async () => {
    const { env } = setup();
    const relay = fakeRelay(() => json(200, {}));
    const { code, text } = await run(['address', 'a.example.com'], env, relay.relayFetch);
    expect(code).toBe(3);
    expect(relay.seen).toHaveLength(0);
    expect(text).toMatch(/ring service/);
  });
});

describe('admin-cli first-admin', () => {
  const people = (list: unknown[]) => () => Promise.resolve(json(200, { people: list }));

  it('prints the first admin with a phone', async () => {
    const out: string[] = [];
    const code = await runAdminCli(['first-admin'], {
      token: 't',
      fetch: people([
        { id: 'p_member', role: 'member', devices: [{}] },
        { id: 'p_admin_nophone', role: 'admin', devices: [] },
        { id: 'p_admin', role: 'admin', devices: [{}] },
      ]),
      out: (text) => out.push(text),
    });
    expect(code).toBe(0);
    expect(out).toEqual(['p_admin']);
  });

  it('exits 1 while no admin has paired', async () => {
    const code = await runAdminCli(['first-admin'], {
      token: 't',
      fetch: people([{ id: 'p', role: 'admin', devices: [] }]),
      out: () => undefined,
    });
    expect(code).toBe(1);
  });
});

describe('admin-cli code --qr', () => {
  function listener() {
    const seen: { url: string; body?: string }[] = [];
    const fake = (url: string, init?: RequestInit) => {
      seen.push({ url, body: init?.body as string | undefined });
      if (url.endsWith('/admin/codes')) {
        return Promise.resolve(
          json(201, { code: 'K7QM-2XPA', expires_at: '2026-10-29T12:10:00.000Z' }),
        );
      }
      return Promise.resolve(json(200, { server_id: 'srv_abc', people: 0, admins: 0, devices: 0 }));
    };
    return { fake: fake as unknown as typeof fetch, seen };
  }

  it('prints the code, the pairing link and a terminal QR of that link', async () => {
    const { fake, seen } = listener();
    const out: string[] = [];
    const code = await runAdminCli(['code', '--admin', '--qr'], {
      token: 't',
      fetch: fake,
      env: { CORD_PUBLIC_URL: 'https://203-0-113-7.sslip.io' },
      out: (text) => out.push(text),
    });
    expect(code).toBe(0);
    expect(JSON.parse(seen[0]!.body!)).toEqual({ role: 'admin' });
    const text = out.join('\n');
    expect(text).toContain(
      'twring://pair?server=https%3A%2F%2F203-0-113-7.sslip.io&code=K7QM-2XPA&id=srv_abc',
    );
    expect(text).toContain(
      buildPairLink({
        server: 'https://203-0-113-7.sslip.io',
        code: 'K7QM-2XPA',
        serverId: 'srv_abc',
      }),
    );
    expect(text).toContain('K7QM-2XPA (valid 10 minutes)');
    // A terminal QR: rows of block characters.
    expect(text).toMatch(/[▀▄█]{10,}/);
  });

  it('a member code without --qr stays plain JSON', async () => {
    const { fake } = listener();
    const out: string[] = [];
    expect(
      await runAdminCli(['code', 'member'], { token: 't', fetch: fake, out: (t) => out.push(t) }),
    ).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ code: 'K7QM-2XPA' });
  });
});

describe('admin-cli register refusal', () => {
  it("shows the relay's reason, not its whole body", async () => {
    const { env } = setup();
    const relay = fakeRelay(() =>
      json(403, { error: { code: 'forbidden', message: 'This email cannot register.' } }),
    );
    const { code, text } = await run(
      ['register', '--email', 'a@example.com', '--news', 'no'],
      env,
      relay.relayFetch,
    );
    expect(code).toBe(3);
    expect(text).toContain('403');
    expect(text).toContain('This email cannot register.');
  });
});
