import {
  base64urlDecode,
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  pairingMac,
  safetyCode,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { memoryStore } from './test-fixtures';
import { loadOrCreateDeviceKey } from './device-key';
import {
  claimPairing,
  confirmPairing,
  loadTrusted,
  parsePairInput,
  type PairApi,
  type PairInput,
} from './pairing';

const computer = generateSealKeyPair();
const K = base64urlEncode(computer.publicKey);
const SECRET = new Uint8Array(32).fill(7);
const OFFER = 'off_' + 'a'.repeat(20);

/** The connector's QR text (apps/connector/src/e2e/pair.ts `pairLink`). */
function makeQr(over: Record<string, unknown> = {}): string {
  const link = { s: 'https://api.twring.com', o: OFFER, k: K, x: base64urlEncode(SECRET), ...over };
  return `twring-pair:${base64urlEncode(new TextEncoder().encode(JSON.stringify(link)))}`;
}

function fakeApi(
  answer: { status?: number; body?: unknown; throws?: boolean } = {},
): PairApi & { claim: ReturnType<typeof vi.fn> } {
  return {
    claim: vi.fn(() => {
      if (answer.throws) return Promise.reject(new Error('offline'));
      return Promise.resolve({
        status: answer.status ?? 200,
        body: answer.body ?? {
          connector_public_key: K,
          connector_device_id: deviceIdFor(computer.publicKey),
        },
      });
    }),
  };
}

function deps(api: PairApi) {
  const store = memoryStore();
  return { api, store, phoneName: 'Pixel', now: () => Date.parse('2026-11-25T00:00:00Z') };
}

const input = (text = makeQr()): PairInput => parsePairInput(text)!;

describe('pairing client', () => {
  it('reads the computer QR and nothing else', () => {
    expect(input()).toMatchObject({
      kind: 'qr',
      offer: { offer_id: OFFER, connector_public_key: K },
    });
    expect(parsePairInput('https://example.com')).toBeUndefined();
    expect(parsePairInput('twring-pair:%%%')).toBeUndefined();
    expect(parsePairInput(makeQr({ k: 'short' }))).toBeUndefined();
    expect(parsePairInput('ABCD-EFGH-JKMN')).toBeUndefined();
  });

  it('sends a MAC the computer accepts, over both keys, both ids and the name', async () => {
    const api = fakeApi();
    const d = deps(api);
    await claimPairing(d, input());
    const phone = await loadOrCreateDeviceKey(d.store);
    const [offerId, body] = api.claim.mock.calls[0] as [string, Record<string, string>];
    expect(offerId).toBe(OFFER);
    expect(body.phone_device_id).toBe(phone.deviceId);
    expect(body.mac).toBe(
      pairingMac(SECRET, {
        connectorPublic: computer.publicKey,
        phonePublic: phone.publicKey,
        connectorDeviceId: deviceIdFor(computer.publicKey),
        phoneDeviceId: phone.deviceId,
        phoneName: 'Pixel',
      }),
    );
    expect(JSON.stringify(body)).not.toContain(base64urlEncode(SECRET));
  });

  it('shows the same safety code as the computer', async () => {
    const d = deps(fakeApi());
    const res = await claimPairing(d, input());
    const phone = await loadOrCreateDeviceKey(d.store);
    expect(res.ok && res.safety).toBe(safetyCode(computer.publicKey, phone.publicKey));
  });

  it('rejects a swapped connector key and stores nothing', async () => {
    const other = generateSealKeyPair().publicKey;
    const d = deps(
      fakeApi({
        body: {
          connector_public_key: base64urlEncode(other),
          connector_device_id: deviceIdFor(other),
        },
      }),
    );
    expect(await claimPairing(d, input())).toEqual({ ok: false, code: 'mismatch' });
    expect(await loadTrusted(d.store)).toEqual([]);
  });

  it('rejects a device id that is not the QR key', async () => {
    const d = deps(
      fakeApi({ body: { connector_public_key: K, connector_device_id: 'dev_' + 'b'.repeat(20) } }),
    );
    expect(await claimPairing(d, input())).toEqual({ ok: false, code: 'mismatch' });
  });

  it('rejects a malformed answer', async () => {
    const d = deps(fakeApi({ body: { nope: 1 } }));
    expect(await claimPairing(d, input())).toEqual({ ok: false, code: 'mismatch' });
  });

  it('maps refusals to what the person can do', async () => {
    const err = (code: string) => ({ error: { code, message: 'x' } });
    const cases: [number, string, string][] = [
      [409, 'device_cap', 'cap'],
      [409, 'offer_claimed', 'claimed'],
      [410, 'offer_expired', 'expired'],
      [404, 'not_found', 'expired'],
      [429, 'rate_limited', 'network'],
      [500, 'internal', 'network'],
    ];
    for (const [status, code, want] of cases) {
      const d = deps(fakeApi({ status, body: err(code) }));
      expect(await claimPairing(d, input())).toEqual({ ok: false, code: want });
    }
    expect(await claimPairing(deps(fakeApi({ throws: true })), input())).toEqual({
      ok: false,
      code: 'network',
    });
  });

  it('stores the computer only on confirm, once, replacing an older entry', async () => {
    const d = deps(fakeApi());
    const res = await claimPairing(d, input());
    if (!res.ok) throw new Error('expected ok');
    expect(await loadTrusted(d.store)).toEqual([]);
    await confirmPairing(d, res.connector);
    await confirmPairing(d, res.connector);
    const list = await loadTrusted(d.store);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: deviceIdFor(computer.publicKey),
      kind: 'computer',
      public_key: K,
    });
    expect(base64urlDecode(list[0].public_key)).toEqual(computer.publicKey);
  });

  it('reads a damaged trusted list as empty', async () => {
    const d = deps(fakeApi());
    d.store.m.set('twring.e2e.trusted.v1', '[{"id":1}]');
    expect(await loadTrusted(d.store)).toEqual([]);
  });
});

describe('pairing with the server the code names', () => {
  it('refuses a code for another server before any key is made or call sent', async () => {
    const api = fakeApi();
    const d = { ...deps(api), activeServer: 'https://staging.example.com' };
    expect(await claimPairing(d, input())).toEqual({ ok: false, code: 'wrong_server' });
    expect(api.claim.mock.calls).toHaveLength(0);
    expect(d.store.m.size).toBe(0);
  });

  it('accepts the same server written with a trailing slash', async () => {
    const d = { ...deps(fakeApi()), activeServer: 'https://api.twring.com/' };
    expect((await claimPairing(d, input())).ok).toBe(true);
  });
});
