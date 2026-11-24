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
      unwrapKey(wrapKey(newMessageKey(), s.privateKey, a.publicKey, aad), b.privateKey, s.publicKey, aad),
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
  it('binds the mac to both keys', () => {
    const s = new Uint8Array(32).fill(1);
    const c = generateSealKeyPair().publicKey;
    const p = generateSealKeyPair().publicKey;
    expect(pairingMac(s, c, p)).not.toBe(pairingMac(s, p, c));
    expect(base64urlEncode(c)).not.toBe(pairingMac(s, c, p));
  });
});
