import {
  base64urlDecode,
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  normalizeTypedPairCode,
  offerConnectorMacMatches,
  offerKeyMacMatches,
  pairingMac,
  safetyCode,
  splitTypedPairCode,
  typedPairKey,
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
  /** The phone pairs with the typed code instead of the QR. */
  typed?: boolean;
  /** The server rewrites which key the claim says it used. */
  flipKey?: boolean;
  /** Offers answered 409 handle_taken before one is taken. */
  handleTaken?: number;
  /** A server from before typed codes: the new offer fields are refused with 400. */
  oldServer?: boolean;
  /** A server from before the connector commitment (R4-2): `connector_mac` is refused with 400. */
  noConnectorMac?: boolean;
}

/** In-memory gateway pairing routes; the "phone" claims with the secret it read from the QR. */
function fakeServer(options: FakeServerOptions = {}) {
  const phone = generateSealKeyPair();
  const phoneId = deviceIdFor(phone.publicKey);
  const addedDevices: string[] = [];
  const requests: { method: string; path: string; auth?: string }[] = [];
  let offered:
    | { key: string; device: string; handle?: string; keyMac?: string; connectorMac?: string }
    | undefined;
  const handles: string[] = [];
  let taken = 0;
  let polls = 0;
  let qr: string | undefined;
  let typedCode: string | undefined;
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
      if (body.handle !== undefined) handles.push(body.handle);
      if (options.oldServer && body.handle !== undefined)
        return json(400, { error: { code: 'bad_request', message: 'x' } });
      if (options.noConnectorMac && body.connector_mac !== undefined)
        return json(400, { error: { code: 'bad_request', message: 'x' } });
      if (taken++ < (options.handleTaken ?? 0))
        return json(409, { error: { code: 'handle_taken', message: 'x' } });
      offered = {
        key: body.connector_public_key!,
        device: body.connector_device_id!,
        ...(body.handle !== undefined && { handle: body.handle }),
        ...(body.key_mac !== undefined && { keyMac: body.key_mac }),
        ...(body.connector_mac !== undefined && { connectorMac: body.connector_mac }),
      };
      // Ten minutes from the real clock: pairing compares it with Date.now().
      return json(200, {
        offer_id: OFFER,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    if (method === 'GET' && url.pathname === `/v1/e2e/pairings/${OFFER}`) {
      if (options.expired) return json(410, { error: { code: 'offer_expired', message: 'x' } });
      if (polls++ < (options.waits ?? 0)) return new Response(null, { status: 204 });
      let secret = base64urlDecode(parsePairLink(qr!)!.x);
      let key: 'qr' | 'typed' | undefined;
      if (options.typed) {
        // The phone: the handle it typed finds this offer; it checks the commitment first.
        const parts = splitTypedPairCode(normalizeTypedPairCode(typedCode!)!);
        if (parts.handle !== offered!.handle) throw new Error('handle not registered');
        secret = typedPairKey(parts.secret);
        const ok = offerKeyMacMatches(
          secret,
          base64urlDecode(offered!.key),
          offered!.device,
          offered!.keyMac!,
        );
        if (!ok) throw new Error('key_mac does not verify');
        key = 'typed';
      }
      if (options.flipKey) key = key === 'typed' ? 'qr' : 'typed';
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
        ...(key !== undefined && { key }),
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
    handles,
    offered: () => offered,
    setQr: (text: string) => (qr = text),
    setTyped: (text: string) => (typedCode = text),
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
    print: (line) => {
      lines.push(line);
      // What a person reads off the terminal and types into the phone.
      if (/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/.test(line.trim())) server.setTyped(line.trim());
    },
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
    // The typed code is random letters and digits, so it can spell a word like MCP by chance.
    const wording = text.replace(/\b[0-9A-Z]{4}(?:-[0-9A-Z]{4}){3}\b/g, '<code>');
    expect(wording).toContain('<code>');
    expect(wording).not.toMatch(/secret|private key|\bkeys?\b|connector|\bmac\b|mcp|e2e/i);
    expect(text).not.toContain(run.options.config.e2e!.private_key);
    expect(text).not.toContain(parsePairLink(link)!.x);
  });

  it('pairs with the typed code: the claim names the typed key and its mac verifies', async () => {
    const server = fakeServer({ typed: true, waits: 1 });
    const run = deps(server);
    expect(await pairPhone(run.options)).toBe('paired');
    expect(server.addedDevices).toHaveLength(2);
    const at = run.lines.indexOf('Or type this code in the app:');
    expect(at).toBeGreaterThan(-1);
    expect(run.lines[at + 1]).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  });

  it('refuses a claim whose key kind the server changed, either way', async () => {
    for (const typed of [true, false]) {
      const server = fakeServer({ typed, flipKey: true });
      const run = deps(server);
      expect(await pairPhone(run.options)).toBe('mismatch');
      expect(server.addedDevices).toHaveLength(0);
      expect(run.saved()).toBeUndefined();
    }
  });

  it('picks a new code when the server says the handle is taken', async () => {
    const server = fakeServer({ typed: true, handleTaken: 2 });
    const run = deps(server);
    expect(await pairPhone(run.options)).toBe('paired');
    expect(server.handles).toHaveLength(3);
    // The code shown is the one the server finally took.
    const shown = run.lines[run.lines.indexOf('Or type this code in the app:') + 1]!;
    expect(shown.slice(0, 4)).toBe(server.handles[2]);
  });

  it('still pairs by QR with a server from before typed codes, showing no typed code', async () => {
    const server = fakeServer({ oldServer: true });
    const run = deps(server);
    expect(await pairPhone(run.options)).toBe('paired');
    expect(run.lines).not.toContain('Or type this code in the app:');
    // A typed claim cannot verify when no typed code was offered.
    const flipped = deps(fakeServer({ oldServer: true, flipKey: true }));
    expect(await pairPhone(flipped.options)).toBe('mismatch');
  });

  it('commits the typed offer to this connector (R4-2), checkable with the typed code', async () => {
    const server = fakeServer({ typed: true });
    const run = deps(server);
    expect(await pairPhone(run.options)).toBe('paired');
    const offer = server.offered()!;
    const shown = run.lines[run.lines.indexOf('Or type this code in the app:') + 1]!;
    const key = typedPairKey(splitTypedPairCode(normalizeTypedPairCode(shown)!).secret);
    const pub = base64urlDecode(offer.key);
    const id = run.options.config.connector_id;
    expect(offerConnectorMacMatches(key, pub, offer.device, id, offer.connectorMac!)).toBe(true);
    expect(offerConnectorMacMatches(key, pub, offer.device, `${id}x`, offer.connectorMac!)).toBe(
      false,
    );
  });

  it('still offers the typed code to a server from before the connector commitment', async () => {
    const server = fakeServer({ typed: true, noConnectorMac: true });
    const run = deps(server);
    expect(await pairPhone(run.options)).toBe('paired');
    expect(run.lines).toContain('Or type this code in the app:');
    expect(server.offered()!.connectorMac).toBeUndefined();
    expect(server.offered()!.keyMac).toBeDefined();
  });

  it('gives up after a few taken handles', async () => {
    const server = fakeServer({ handleTaken: 100 });
    await expect(pairPhone(deps(server).options)).rejects.toThrow();
    expect(server.handles.length).toBeGreaterThan(1);
    expect(server.handles.length).toBeLessThanOrEqual(5);
  });

  it('shows the typed code once and never sends its secret part to the server', async () => {
    const server = fakeServer({ typed: true });
    const seen: string[] = [];
    const run = deps(server, {
      fetch: ((input: string | URL, init?: RequestInit) => {
        seen.push(String(input), JSON.stringify(init?.body ?? ''));
        return server.fetchImpl(input, init);
      }) as typeof fetch,
    });
    expect(await pairPhone(run.options)).toBe('paired');
    const shown = run.lines[run.lines.indexOf('Or type this code in the app:') + 1]!;
    const { handle, secret } = splitTypedPairCode(normalizeTypedPairCode(shown)!);
    const all = seen.join(' ');
    expect(all).toContain(handle);
    expect(all).not.toContain(secret);
    expect(all).not.toContain(base64urlEncode(typedPairKey(secret)));
    expect(run.lines.filter((line) => line.replace(/-/g, '').includes(secret))).toHaveLength(1);
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
      // The connector id rides in the fragment: phones read only the origin (R4-2).
      s: `https://api.twring.com/#c=${run.options.config.connector_id}`,
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
