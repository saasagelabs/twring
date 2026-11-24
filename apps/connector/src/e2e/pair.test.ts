import {
  base64urlDecode,
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  pairingMac,
  safetyCode,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { e2eConfigSchema, ensureDeviceKey, type E2eConfig } from './keys';
import { pairPhone, parsePairLink, type PairPhoneOptions } from './pair';
import { baseConfig } from './test-fixtures';

const OFFER = `off_${'b'.repeat(20)}`;

interface FakeServerOptions {
  tamperMac?: boolean;
  swapPhoneKey?: boolean;
  /** The server hands over a device id or name other than the one the phone sent. */
  swapDeviceId?: string;
  swapName?: string;
  expired?: boolean;
  cap?: boolean;
  /** How adding the devices fails: a refusal, or a dropped link before or after the server added. */
  addFails?: 'refused' | 'network' | 'network-after-add';
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
  const handle = (input: string | URL, init?: RequestInit): Response => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization') ?? undefined;
    requests.push({ method, path: url.pathname, ...(auth !== null && { auth }) });
    if (method === 'POST' && url.pathname === '/v1/e2e/pairings') {
      const body = JSON.parse(init?.body as string) as Record<string, string>;
      offered = { key: body.connector_public_key!, device: body.connector_device_id! };
      return json(200, { offer_id: OFFER, expires_at: '2026-11-25T00:10:00.000Z' });
    }
    if (method === 'GET' && url.pathname === `/v1/e2e/pairings/${OFFER}`) {
      if (options.expired) return json(410, { error: { code: 'offer_expired', message: 'x' } });
      if (polls++ < (options.waits ?? 0)) return new Response(null, { status: 204 });
      const link = parsePairLink(qr!)!;
      const secret = base64urlDecode(link.x);
      const claimedKey = options.swapPhoneKey ? generateSealKeyPair().publicKey : phone.publicKey;
      const mac = pairingMac(secret, {
        connectorPublic: base64urlDecode(offered!.key),
        phonePublic: phone.publicKey,
        connectorDeviceId: offered!.device,
        phoneDeviceId: phoneId,
        phoneName: 'Pixel',
      });
      return json(200, {
        phone_device_id: options.swapDeviceId ?? phoneId,
        phone_public_key: base64urlEncode(claimedKey),
        phone_name: options.swapName ?? 'Pixel',
        mac: options.tamperMac ? `${mac.slice(0, -2)}AA` : mac,
      });
    }
    if (method === 'POST' && url.pathname === '/v1/e2e/computer/devices') {
      if (options.cap) return json(409, { error: { code: 'device_cap', message: 'x' } });
      if (options.addFails === 'refused')
        return json(500, { error: { code: 'internal', message: 'x' } });
      if (options.addFails === 'network') throw new TypeError('fetch failed');
      addedDevices.push(offered!.device, phoneId);
      if (options.addFails === 'network-after-add') throw new TypeError('fetch failed');
      return json(200, { devices: [] });
    }
    if (method === 'GET' && url.pathname === '/v1/e2e/computer/devices') {
      return json(200, {
        devices: addedDevices.includes(phoneId)
          ? [
              {
                id: phoneId,
                kind: 'phone',
                name: 'Pixel',
                public_key: base64urlEncode(phone.publicKey),
                added_at: '2026-11-25T00:00:00.000Z',
              },
            ]
          : [],
      });
    }
    return json(404, { error: { code: 'not_found', message: 'x' } });
  };
  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    try {
      return Promise.resolve(handle(input, init));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
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

function deps(
  server: ReturnType<typeof fakeServer>,
  over: Partial<PairPhoneOptions> = {},
  failSave?: (call: number) => boolean,
) {
  const config = ensureDeviceKey(baseConfig).config;
  let e2e: E2eConfig = config.e2e!;
  let changed = false;
  let calls = 0;
  const lines: string[] = [];
  const options: PairPhoneOptions = {
    config,
    fetch: server.fetchImpl,
    print: (line) => lines.push(line),
    qr: (text) => {
      server.setQr(text);
      return '[qr]';
    },
    confirm: () => Promise.resolve(true),
    update: (change) => {
      if (failSave?.(++calls)) return Promise.reject(new Error('disk full'));
      e2e = change(e2e);
      changed = true;
      return Promise.resolve();
    },
    signal: new AbortController().signal,
    ...over,
  };
  return { options, lines, saved: () => (changed ? e2e : undefined) };
}

describe('pairPhone', () => {
  it('pairs when the mac verifies and the user confirms the code', async () => {
    const server = fakeServer({ waits: 1 });
    const run = deps(server);
    expect(await pairPhone(run.options)).toBe('paired');
    expect(server.addedDevices).toHaveLength(2);
    const trusted = run.saved()!.devices;
    expect(trusted).toEqual([
      expect.objectContaining({
        id: server.phoneId,
        kind: 'phone',
        name: 'Pixel',
        public_key: base64urlEncode(server.phone.publicKey),
      }),
    ]);
    expect(run.saved()!.pending ?? []).toEqual([]);
    expect(server.requests.every((r) => r.auth === `Bearer ${baseConfig.token}`)).toBe(true);
  });

  it('adds nothing on the server when this computer cannot save the phone first', async () => {
    const server = fakeServer();
    const run = deps(server, {}, () => true);
    await expect(pairPhone(run.options)).rejects.toThrow();
    expect(server.addedDevices).toHaveLength(0);
    expect(run.saved()).toBeUndefined();
  });

  it('keeps nothing here when the server refuses to add the phone', async () => {
    const server = fakeServer({ addFails: 'refused' });
    const run = deps(server);
    await expect(pairPhone(run.options)).rejects.toThrow();
    expect(server.addedDevices).toHaveLength(0);
    expect(run.saved()!.devices).toEqual([]);
    expect(run.saved()!.pending ?? []).toEqual([]);
  });

  it('asks the server whether the add went through when the link dropped', async () => {
    const lost = deps(fakeServer({ addFails: 'network' }));
    await expect(pairPhone(lost.options)).rejects.toThrow();
    expect(lost.saved()!.devices).toEqual([]);
    expect(lost.saved()!.pending ?? []).toEqual([]);

    const server = fakeServer({ addFails: 'network-after-add' });
    const made = deps(server);
    expect(await pairPhone(made.options)).toBe('paired');
    expect(made.saved()!.devices.map((d) => d.id)).toEqual([server.phoneId]);
    expect(made.saved()!.pending ?? []).toEqual([]);
  });

  it('leaves the phone pending (never trusted) when the last save fails after the server added it', async () => {
    const server = fakeServer();
    const run = deps(server, {}, (call) => call === 2);
    await expect(pairPhone(run.options)).rejects.toThrow();
    expect(server.addedDevices).toContain(server.phoneId);
    expect(run.saved()!.devices).toEqual([]);
    // The next device sync trusts it (sync.test.ts): both sides then agree.
    expect(run.saved()!.pending!.map((d) => d.id)).toEqual([server.phoneId]);
  });

  it('never saves more pending phones than the config allows (the file would read as damaged)', async () => {
    const server = fakeServer();
    const stale = Array.from({ length: 4 }, () => {
      const key = generateSealKeyPair().publicKey;
      return {
        id: deviceIdFor(key),
        kind: 'phone' as const,
        name: 'Old',
        public_key: base64urlEncode(key),
        verified_at: '2026-11-24T00:00:00.000Z',
      };
    });
    let e2e: E2eConfig = { ...ensureDeviceKey(baseConfig).config.e2e!, pending: stale };
    let calls = 0;
    const run = deps(server, {
      update: (change) => {
        // The last save fails, so the new phone stays pending next to the four old ones.
        if (++calls === 2) return Promise.reject(new Error('disk full'));
        e2e = change(e2e);
        return Promise.resolve();
      },
    });
    await expect(pairPhone(run.options)).rejects.toThrow();
    expect(e2eConfigSchema.safeParse(e2e).success).toBe(true);
    expect(e2e.pending!.map((d) => d.id)).toContain(server.phoneId);
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

  it('refuses a device id or name the server changed, and adds nothing', async () => {
    for (const over of [{ swapDeviceId: `dev_${'z'.repeat(20)}` }, { swapName: 'Old phone' }]) {
      const server = fakeServer(over);
      const run = deps(server);
      expect(await pairPhone(run.options)).toBe('mismatch');
      expect(server.addedDevices).toHaveLength(0);
      expect(run.saved()).toBeUndefined();
    }
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
    expect(run.saved()!.devices).toEqual([]);
    expect(run.saved()!.pending ?? []).toEqual([]);
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest matcher
      x: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });
  it('never sends the QR secret or anything made from it to the server', async () => {
    const server = fakeServer({ waits: 1 });
    const seen: string[] = [];
    let link = '';
    const run = deps(server, {
      fetch: ((input: string | URL, init?: RequestInit) => {
        seen.push(String(input), JSON.stringify(init?.body ?? ''));
        new Headers(init?.headers).forEach((value, name) => seen.push(`${name}:${value}`));
        return server.fetchImpl(input, init);
      }) as typeof fetch,
      qr: (text) => {
        link = text;
        server.setQr(text);
        return '[qr]';
      },
    });
    expect(await pairPhone(run.options)).toBe('paired');
    const secret = parsePairLink(link)!.x;
    const all = seen.join(' ');
    expect(all).not.toContain(secret);
    expect(all).not.toContain(Buffer.from(base64urlDecode(secret)).toString('hex'));
    expect(all).not.toContain(link);
    expect(all).not.toContain(run.options.config.e2e!.private_key);
  });

  it('adds nothing on the server or here when the person says no, the mac fails or it is cancelled mid-wait', async () => {
    for (const over of [
      { confirm: () => Promise.resolve(false) },
      { tamper: true },
      { cancelWhileWaiting: true },
    ] as const) {
      const server = fakeServer({ waits: 2, tamperMac: 'tamper' in over });
      const controller = new AbortController();
      const run = deps(server, {
        signal: controller.signal,
        waitSeconds: 0,
        ...('confirm' in over && { confirm: over.confirm }),
        ...('cancelWhileWaiting' in over && {
          fetch: ((input: string | URL, init?: RequestInit) => {
            if (String(input).includes('wait=')) controller.abort();
            return server.fetchImpl(input, init);
          }) as typeof fetch,
        }),
      });
      expect(await pairPhone(run.options)).not.toBe('paired');
      expect(server.requests.some((r) => r.path === '/v1/e2e/computer/devices')).toBe(false);
      expect(run.saved()).toBeUndefined();
    }
  });
});
