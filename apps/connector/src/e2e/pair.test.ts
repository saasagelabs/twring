import {
  base64urlDecode,
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  pairingMac,
  safetyCode,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import type { ConnectorConfig } from '../config';
import { ensureDeviceKey } from './keys';
import { pairPhone, parsePairLink, type PairPhoneOptions } from './pair';
import { baseConfig } from './test-fixtures';

const OFFER = `off_${'b'.repeat(20)}`;

interface FakeServerOptions {
  tamperMac?: boolean;
  swapPhoneKey?: boolean;
  expired?: boolean;
  cap?: boolean;
  /** 204s before the claim arrives. */
  waits?: number;
}

/** In-memory gateway pairing routes; the "phone" claims with the secret it read from the QR. */
function fakeServer(options: FakeServerOptions = {}) {
  const phone = generateSealKeyPair();
  const phoneId = deviceIdFor(phone.publicKey);
  const addedDevices: string[] = [];
  const requests: { method: string; path: string; auth?: string }[] = [];
  let offered: { key: string; device: string } | undefined;
  let polls = 0;
  let qr: string | undefined;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization') ?? undefined;
    requests.push({ method, path: url.pathname, ...(auth !== null && { auth }) });
    if (method === 'POST' && url.pathname === '/v1/e2e/pairings') {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      offered = { key: body.connector_public_key!, device: body.connector_device_id! };
      return json(200, { offer_id: OFFER, expires_at: '2026-11-25T00:10:00.000Z' });
    }
    if (method === 'GET' && url.pathname === `/v1/e2e/pairings/${OFFER}`) {
      if (options.expired) return json(410, { error: { code: 'offer_expired', message: 'x' } });
      if (polls++ < (options.waits ?? 0)) return new Response(null, { status: 204 });
      const link = parsePairLink(qr!)!;
      const secret = base64urlDecode(link.x);
      const claimedKey = options.swapPhoneKey ? generateSealKeyPair().publicKey : phone.publicKey;
      const mac = pairingMac(secret, base64urlDecode(offered!.key), phone.publicKey);
      return json(200, {
        phone_device_id: phoneId,
        phone_public_key: base64urlEncode(claimedKey),
        phone_name: 'Pixel',
        mac: options.tamperMac ? `${mac.slice(0, -2)}AA` : mac,
      });
    }
    if (method === 'POST' && url.pathname === '/v1/e2e/computer/devices') {
      if (options.cap) return json(409, { error: { code: 'device_cap', message: 'x' } });
      addedDevices.push(offered!.device, phoneId);
      return json(200, { devices: [] });
    }
    return json(404, { error: { code: 'not_found', message: 'x' } });
  }) as typeof fetch;
  return {
    fetchImpl,
    addedDevices,
    requests,
    phone,
    phoneId,
    setQr: (text: string) => (qr = text),
  };
}

function deps(server: ReturnType<typeof fakeServer>, over: Partial<PairPhoneOptions> = {}) {
  let saved: ConnectorConfig | undefined;
  const lines: string[] = [];
  const options: PairPhoneOptions = {
    config: ensureDeviceKey(baseConfig).config,
    fetch: server.fetchImpl,
    print: (line) => lines.push(line),
    qr: (text) => {
      server.setQr(text);
      return '[qr]';
    },
    confirm: () => Promise.resolve(true),
    save: (config) => {
      saved = config;
      return Promise.resolve();
    },
    signal: new AbortController().signal,
    ...over,
  };
  return { options, lines, saved: () => saved };
}

describe('pairPhone', () => {
  it('pairs when the mac verifies and the user confirms the code', async () => {
    const server = fakeServer({ waits: 1 });
    const run = deps(server);
    expect(await pairPhone(run.options)).toBe('paired');
    expect(server.addedDevices).toHaveLength(2);
    const trusted = run.saved()!.e2e!.devices;
    expect(trusted).toEqual([
      expect.objectContaining({
        id: server.phoneId,
        kind: 'phone',
        name: 'Pixel',
        public_key: base64urlEncode(server.phone.publicKey),
      }),
    ]);
    expect(server.requests.every((r) => r.auth === `Bearer ${baseConfig.token}`)).toBe(true);
  });

  it('shows the same safety code the phone computes', async () => {
    const server = fakeServer();
    let shown = '';
    const run = deps(server, {
      confirm: (code) => {
        shown = code;
        return Promise.resolve(true);
      },
    });
    await pairPhone(run.options);
    const mine = base64urlDecode(run.options.config.e2e!.public_key);
    expect(shown).toBe(safetyCode(server.phone.publicKey, mine));
    expect(run.lines.join('\n')).toContain(shown);
  });

  it('refuses a claim whose mac does not match', async () => {
    const server = fakeServer({ tamperMac: true });
    const run = deps(server);
    expect(await pairPhone(run.options)).toBe('mismatch');
    expect(server.addedDevices).toHaveLength(0);
    expect(run.saved()).toBeUndefined();
  });

  it('refuses a phone key swapped by the server', async () => {
    const server = fakeServer({ swapPhoneKey: true });
    const run = deps(server);
    expect(await pairPhone(run.options)).toBe('mismatch');
    expect(server.addedDevices).toHaveLength(0);
  });

  it('stops when the user says the codes differ', async () => {
    const server = fakeServer();
    const run = deps(server, { confirm: () => Promise.resolve(false) });
    expect(await pairPhone(run.options)).toBe('mismatch');
    expect(server.addedDevices).toHaveLength(0);
    expect(run.saved()).toBeUndefined();
  });

  it('says expired when the offer runs out', async () => {
    expect(await pairPhone(deps(fakeServer({ expired: true })).options)).toBe('expired');
  });

  it('says cap when the account has 5 devices', async () => {
    const run = deps(fakeServer({ cap: true }));
    expect(await pairPhone(run.options)).toBe('cap');
    expect(run.saved()).toBeUndefined();
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await pairPhone(deps(fakeServer(), { signal: controller.signal }).options)).toBe(
      'cancelled',
    );
  });

  it('prints no secret to the terminal', async () => {
    const server = fakeServer();
    let link = '';
    const run = deps(server, {
      qr: (text) => {
        link = text;
        server.setQr(text);
        return '[qr]';
      },
    });
    expect(await pairPhone(run.options)).toBe('paired');
    const text = run.lines.join('\n');
    expect(text).not.toMatch(/secret|private key|\bkeys?\b|connector|\bmac\b|mcp|e2e/i);
    expect(text).not.toContain(run.options.config.e2e!.private_key);
    expect(text).not.toContain(parsePairLink(link)!.x);
  });

  it('puts the server, offer, this computer and the secret in the QR', async () => {
    const server = fakeServer();
    let link = '';
    const run = deps(server, {
      qr: (text) => {
        link = text;
        server.setQr(text);
        return '[qr]';
      },
    });
    await pairPhone(run.options);
    expect(link.startsWith('twring-pair:')).toBe(true);
    expect(parsePairLink(link)).toEqual({
      s: 'https://api.twring.com',
      o: OFFER,
      k: run.options.config.e2e!.public_key,
      x: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });
});
