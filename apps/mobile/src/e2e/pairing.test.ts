import {
  base64urlDecode,
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  offerKeyMac,
  pairingMac,
  safetyCode,
  typedPairKey,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { memoryStore } from './test-fixtures';
import { loadOrCreateDeviceKey } from './device-key';
import {
  claimPairing,
  confirmPairing,
  loadTrusted,
  parsePairInput,
  parseTypedPairCode,
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

const TYPED = '7KQ2-M9XD-4HTP-W3RV';
const TYPED_KEY = typedPairKey('M9XD4HTPW3RV');
const lookupAnswer = (over: Record<string, unknown> = {}) => ({
  offer_id: OFFER,
  connector_public_key: K,
  connector_device_id: deviceIdFor(computer.publicKey),
  key_mac: offerKeyMac(TYPED_KEY, computer.publicKey, deviceIdFor(computer.publicKey)),
  ...over,
});

function fakeApi(
  answer: { status?: number; body?: unknown; throws?: boolean } = {},
  found: { status?: number; body?: unknown; throws?: boolean } = {},
): PairApi & { claim: ReturnType<typeof vi.fn>; lookup: ReturnType<typeof vi.fn> } {
  return {
    lookup: vi.fn(() => {
      if (found.throws) return Promise.reject(new Error('offline'));
      return Promise.resolve({ status: found.status ?? 200, body: found.body ?? lookupAnswer() });
    }),
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

  it('records the connector id the claim names, and none from an older server', async () => {
    const CON = `con_${'a'.repeat(20)}`;
    const bound = await claimPairing(
      deps(
        fakeApi({
          body: {
            connector_public_key: K,
            connector_device_id: deviceIdFor(computer.publicKey),
            connector_id: CON,
          },
        }),
      ),
      input(),
    );
    expect(bound.ok && bound.connector.connector_id).toBe(CON);
    const older = await claimPairing(deps(fakeApi()), input());
    expect(older.ok && older.connector.connector_id).toBeUndefined();
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

  describe('typed code', () => {
    const typed = (text = TYPED): PairInput => parseTypedPairCode(text)!;

    it('reads a typed code the way people type it, and nothing else', () => {
      expect(typed('7kq2 m9xd-4htp w3rv')).toEqual({ kind: 'typed', code: '7KQ2M9XD4HTPW3RV' });
      expect(parseTypedPairCode('7KQ2-M9XD-4HTP-W3RU')).toBeUndefined();
      expect(parseTypedPairCode('7KQ2-M9XD-4HTP')).toBeUndefined();
    });

    it('looks up only the handle, checks the commitment, then claims with the typed key', async () => {
      const api = fakeApi();
      const d = deps(api);
      const res = await claimPairing(d, typed());
      const phone = await loadOrCreateDeviceKey(d.store);
      expect(api.lookup.mock.calls[0]).toEqual(['7KQ2']);
      const [offerId, body] = api.claim.mock.calls[0] as [string, Record<string, string>];
      expect(offerId).toBe(OFFER);
      expect(body.key).toBe('typed');
      expect(body.mac).toBe(
        pairingMac(TYPED_KEY, {
          connectorPublic: computer.publicKey,
          phonePublic: phone.publicKey,
          connectorDeviceId: deviceIdFor(computer.publicKey),
          phoneDeviceId: phone.deviceId,
          phoneName: 'Pixel',
        }),
      );
      expect(JSON.stringify([api.lookup.mock.calls, api.claim.mock.calls])).not.toContain(
        'M9XD4HTPW3RV',
      );
      expect(res.ok && res.safety).toBe(safetyCode(computer.publicKey, phone.publicKey));
      expect(res.ok && res.connector.public_key).toBe(K);
    });

    it('says the code did not work when no offer has that handle', async () => {
      const api = fakeApi({}, { status: 404, body: { error: { code: 'not_found' } } });
      expect(await claimPairing(deps(api), typed())).toEqual({ ok: false, code: 'wrong_code' });
      expect(api.claim.mock.calls).toHaveLength(0);
    });

    it('refuses a key the server swapped, before any claim (wrong secret alike)', async () => {
      const other = generateSealKeyPair().publicKey;
      for (const body of [
        lookupAnswer({
          connector_public_key: base64urlEncode(other),
          connector_device_id: deviceIdFor(other),
        }),
        lookupAnswer({ connector_device_id: 'dev_' + 'b'.repeat(20) }),
        lookupAnswer({
          key_mac: offerKeyMac(
            typedPairKey('000000000000'),
            computer.publicKey,
            deviceIdFor(computer.publicKey),
          ),
        }),
        { nope: 1 },
      ]) {
        const api = fakeApi({}, { body });
        const d = deps(api);
        expect(await claimPairing(d, typed())).toEqual({ ok: false, code: 'wrong_code' });
        expect(api.claim.mock.calls).toHaveLength(0);
        expect(await loadTrusted(d.store)).toEqual([]);
      }
    });

    it('refuses a claim answer naming another key than the lookup', async () => {
      const other = generateSealKeyPair().publicKey;
      const api = fakeApi({
        body: {
          connector_public_key: base64urlEncode(other),
          connector_device_id: deviceIdFor(other),
        },
      });
      expect(await claimPairing(deps(api), typed())).toEqual({ ok: false, code: 'wrong_code' });
    });

    it('says the code did not work for a refused claim, except a full device list or no network', async () => {
      const err = (code: string) => ({ error: { code, message: 'x' } });
      const cases: [number, string, string][] = [
        [409, 'offer_claimed', 'wrong_code'],
        [410, 'offer_expired', 'wrong_code'],
        [404, 'not_found', 'wrong_code'],
        [409, 'device_cap', 'cap'],
        [500, 'internal', 'network'],
      ];
      for (const [status, code, want] of cases)
        expect(await claimPairing(deps(fakeApi({ status, body: err(code) })), typed())).toEqual({
          ok: false,
          code: want,
        });
    });

    it('asks to wait when lookups are rate limited, and says no network when offline', async () => {
      const limited = fakeApi({}, { status: 429, body: { error: { code: 'rate_limited' } } });
      expect(await claimPairing(deps(limited), typed())).toEqual({ ok: false, code: 'too_many' });
      expect(await claimPairing(deps(fakeApi({}, { throws: true })), typed())).toEqual({
        ok: false,
        code: 'network',
      });
    });
  });
});
