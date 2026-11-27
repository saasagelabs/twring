import { describe, expect, it } from 'vitest';
import { base64urlEncode, generateSealKeyPair } from './seal-core';
import {
  messageAad,
  newMessageKey,
  openBody,
  pairingMac,
  safetyCode,
  sealBody,
  unwrapKey,
  wrapKey,
} from './message-seal';

const aad = messageAad({
  accountId: 'u1',
  agentId: 'agt_1',
  senderDevice: 'dev_aaaaaaaaaaaaaaaaaaaa',
  senderSeq: 3,
});

describe('messageAad versions (ADR-044 amendment)', () => {
  const base = { accountId: 'u1', agentId: 'agt_1', senderDevice: 'dev_a', senderSeq: 3 };
  const text = (b: Uint8Array) => String.fromCharCode(...b);
  it('keeps v1 byte for byte without a final flag', () => {
    expect(text(messageAad({ ...base, chunk: 2 }))).toBe(
      '["twring-e2e-v1","u1","agt_1","dev_a",3,2]',
    );
    expect(text(messageAad({ ...base, final: true }))).toBe(
      '["twring-e2e-v1","u1","agt_1","dev_a",3,null]',
    );
  });
  it('binds the final flag in v2', () => {
    expect(text(messageAad({ ...base, chunk: 2, final: false }))).toBe(
      '["twring-e2e-v2","u1","agt_1","dev_a",3,2,false]',
    );
    const key = newMessageKey();
    const sealed = sealBody(key, { text: 'hi' }, messageAad({ ...base, chunk: 2, final: false }));
    expect(() =>
      openBody(key, sealed.nonce, sealed.body, messageAad({ ...base, chunk: 2, final: true })),
    ).toThrow();
    expect(() =>
      openBody(key, sealed.nonce, sealed.body, messageAad({ ...base, chunk: 2 })),
    ).toThrow();
  });
});

describe('message seal', () => {
  it('round-trips a payload through wrap and seal', () => {
    const computer = generateSealKeyPair();
    const phone = generateSealKeyPair();
    const key = newMessageKey();
    const wrapped = wrapKey(key, computer.privateKey, phone.publicKey, aad);
    const sealed = sealBody(key, { text: 'hello' }, aad);
    expect(
      openBody(
        unwrapKey(wrapped, phone.privateKey, computer.publicKey, aad),
        sealed.nonce,
        sealed.body,
        aad,
      ),
    ).toEqual({ text: 'hello' });
  });
  it('refuses a different seq in the AAD', () => {
    const key = newMessageKey();
    const sealed = sealBody(key, { text: 'hi' }, aad);
    const other = messageAad({
      accountId: 'u1',
      agentId: 'agt_1',
      senderDevice: 'dev_aaaaaaaaaaaaaaaaaaaa',
      senderSeq: 4,
    });
    expect(() => openBody(key, sealed.nonce, sealed.body, other)).toThrow();
  });
  it('refuses a key wrapped for another device', () => {
    const s = generateSealKeyPair();
    const a = generateSealKeyPair();
    const b = generateSealKeyPair();
    expect(() =>
      unwrapKey(
        wrapKey(newMessageKey(), s.privateKey, a.publicKey, aad),
        b.privateKey,
        s.publicKey,
        aad,
      ),
    ).toThrow();
  });
  it('refuses a forged sender: a stranger wraps to me claiming to be my trusted computer', () => {
    const trusted = generateSealKeyPair();
    const stranger = generateSealKeyPair(); // e.g. the server, which knows my public key
    const me = generateSealKeyPair();
    const forged = wrapKey(newMessageKey(), stranger.privateKey, me.publicKey, aad);
    expect(() => unwrapKey(forged, me.privateKey, trusted.publicKey, aad)).toThrow();
  });
  it('refuses a wrapped key moved to another message (AAD bound)', () => {
    const s = generateSealKeyPair();
    const me = generateSealKeyPair();
    const wrapped = wrapKey(newMessageKey(), s.privateKey, me.publicKey, aad);
    const other = messageAad({
      accountId: 'u1',
      agentId: 'agt_2',
      senderDevice: 'dev_aaaaaaaaaaaaaaaaaaaa',
      senderSeq: 3,
    });
    expect(() => unwrapKey(wrapped, me.privateKey, s.publicKey, other)).toThrow();
  });
  it('gives the same safety code on both sides and a new one for a swapped key', () => {
    const c = generateSealKeyPair().publicKey;
    const p = generateSealKeyPair().publicKey;
    const evil = generateSealKeyPair().publicKey;
    expect(safetyCode(c, p)).toBe(safetyCode(p, c));
    expect(safetyCode(c, p)).toMatch(/^\d{3} \d{3}$/);
    expect(safetyCode(evil, p)).not.toBe(safetyCode(c, p));
  });
  it('binds the mac to both keys, both device ids and the phone name', () => {
    const s = new Uint8Array(32).fill(1);
    const c = generateSealKeyPair().publicKey;
    const p = generateSealKeyPair().publicKey;
    const input = {
      connectorPublic: c,
      phonePublic: p,
      connectorDeviceId: `dev_${'c'.repeat(20)}`,
      phoneDeviceId: `dev_${'p'.repeat(20)}`,
      phoneName: 'Pixel',
    };
    const mac = pairingMac(s, input);
    expect(pairingMac(s, { ...input })).toBe(mac);
    expect(pairingMac(s, { ...input, connectorPublic: p, phonePublic: c })).not.toBe(mac);
    expect(pairingMac(s, { ...input, phoneDeviceId: `dev_${'q'.repeat(20)}` })).not.toBe(mac);
    expect(pairingMac(s, { ...input, connectorDeviceId: `dev_${'d'.repeat(20)}` })).not.toBe(mac);
    expect(pairingMac(s, { ...input, phoneName: 'Pixel 2' })).not.toBe(mac);
    // Length-prefixed: moving a character from one text field to the next changes the MAC.
    expect(
      pairingMac(s, { ...input, phoneDeviceId: `${input.phoneDeviceId}P`, phoneName: 'ixel' }),
    ).not.toBe(mac);
    expect(base64urlEncode(c)).not.toBe(mac);
  });
  it('keeps the pairing mac input fixed (the phone must compute the same bytes)', () => {
    const mac = pairingMac(new Uint8Array(32).fill(7), {
      connectorPublic: new Uint8Array(32).fill(1),
      phonePublic: new Uint8Array(32).fill(2),
      connectorDeviceId: `dev_${'a'.repeat(20)}`,
      phoneDeviceId: `dev_${'b'.repeat(20)}`,
      phoneName: 'Pixel',
    });
    expect(mac).toMatchInlineSnapshot(`"Vfa4JNY_uuKXRhK0FspI22RQfpAXskrgOqTp9soh-Gs"`);
  });
});

describe('sealed payload', () => {
  it('carries who was quoted and the could-not-open notice', () => {
    const key = newMessageKey();
    const payload = {
      text: '',
      notice: 'couldnt_open' as const,
      quote: { message_id: `msg_${'a'.repeat(20)}`, text: 'Ship it?', from: 'agent' as const },
    };
    const sealed = sealBody(key, payload, aad);
    expect(openBody(key, sealed.nonce, sealed.body, aad)).toEqual(payload);
  });
});
