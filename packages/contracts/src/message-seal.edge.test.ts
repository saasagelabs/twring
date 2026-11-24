import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { utf8ToBytes } from '@noble/ciphers/utils.js';
import { describe, expect, it } from 'vitest';

import { relayConnectorMessageSchema, relayGatewayMessageSchema } from './connectors';
import {
  messageAad,
  newMessageKey,
  openBody,
  safetyCode,
  sealBody,
  unwrapKey,
  wrapKey,
} from './message-seal';
import { base64urlDecode, base64urlEncode, generateSealKeyPair, SealError } from './seal-core';
import {
  MAX_PAIRED_DEVICES,
  MAX_SEALED_AGENT_BODY_CHARS,
  MAX_SEALED_BODY_CHARS,
  publicKeySchema,
  sealedEnvelopeV1Schema,
} from './sealed-chat';
import { threadMessageSchema } from './threads';

const aad = messageAad({
  accountId: 'u1',
  agentId: 'agt_1',
  senderDevice: 'dev_aaaaaaaaaaaaaaaaaaaa',
  senderSeq: 1,
});

function flip(text: string, at: number): string {
  const b = base64urlDecode(text);
  b[at] = b[at]! ^ 1;
  return base64urlEncode(b);
}

function expectSealError(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(SealError);
}

/** Seals arbitrary JSON with the right key and AAD, bypassing sealBody's own schema check. */
function sealRaw(key: Uint8Array, value: unknown): { nonce: string; body: string } {
  const nonce = new Uint8Array(24).fill(7);
  const body = xchacha20poly1305(key, nonce, aad).encrypt(utf8ToBytes(JSON.stringify(value)));
  return { nonce: base64urlEncode(nonce), body: base64urlEncode(body) };
}

describe('message seal edge cases', () => {
  it('uses a fresh 24-byte nonce for every seal and every wrap', () => {
    const a = generateSealKeyPair();
    const b = generateSealKeyPair();
    const key = newMessageKey();
    const n1 = sealBody(key, { text: 'x' }, aad).nonce;
    const n2 = sealBody(key, { text: 'x' }, aad).nonce;
    expect(base64urlDecode(n1)).toHaveLength(24);
    expect(n1).not.toBe(n2);
    const w1 = base64urlDecode(wrapKey(key, a.privateKey, b.publicKey, aad));
    const w2 = base64urlDecode(wrapKey(key, a.privateKey, b.publicKey, aad));
    expect(base64urlEncode(w1.subarray(0, 24))).not.toBe(base64urlEncode(w2.subarray(0, 24)));
  });

  it('throws SealError for every tampered or malformed input', () => {
    const a = generateSealKeyPair();
    const b = generateSealKeyPair();
    const c = generateSealKeyPair();
    const key = newMessageKey();
    const wrapped = wrapKey(key, a.privateKey, b.publicKey, aad);
    const sealed = sealBody(key, { text: 'hi' }, aad);
    expectSealError(() => unwrapKey(wrapped, b.privateKey, c.publicKey, aad));
    expectSealError(() => unwrapKey(wrapped, c.privateKey, a.publicKey, aad));
    expectSealError(() => unwrapKey(flip(wrapped, 0), b.privateKey, a.publicKey, aad));
    expectSealError(() => unwrapKey(flip(wrapped, 40), b.privateKey, a.publicKey, aad));
    expectSealError(() => unwrapKey(wrapped.slice(0, 30), b.privateKey, a.publicKey, aad));
    expectSealError(() => unwrapKey('', b.privateKey, a.publicKey, aad));
    expectSealError(() => unwrapKey('!!!not base64', b.privateKey, a.publicKey, aad));
    expectSealError(() => unwrapKey(wrapped, b.privateKey.subarray(0, 31), a.publicKey, aad));
    expectSealError(() => unwrapKey(wrapped, b.privateKey, new Uint8Array(32), aad));
    expectSealError(() => openBody(key, flip(sealed.nonce, 3), sealed.body, aad));
    expectSealError(() => openBody(key, sealed.nonce, flip(sealed.body, 0), aad));
    expectSealError(() => openBody(key, sealed.nonce.slice(0, 20), sealed.body, aad));
    expectSealError(() => openBody(key, sealed.nonce, sealed.body.slice(0, 10), aad));
    expectSealError(() => openBody(key, sealed.nonce, '', aad));
    expectSealError(() => openBody(key, 'a*b', sealed.body, aad));
    expectSealError(() => openBody(key.subarray(1), sealed.nonce, sealed.body, aad));
  });

  it('refuses an authentic payload that fails the schema or exceeds limits', () => {
    const key = newMessageKey();
    const ok = sealRaw(key, { text: 'fine' });
    expect(openBody(key, ok.nonce, ok.body, aad)).toEqual({ text: 'fine' });
    for (const bad of [
      { text: 'x'.repeat(20_001) },
      { text: 'x', extra: 1 },
      { text: 'x', voice: true },
      {
        text: 'x',
        files: Array(11).fill({ file_id: 'f', key: 'k', name: 'n', mime: 'm', size: 1 }),
      },
      'just a string',
      null,
    ]) {
      const s = sealRaw(key, bad);
      expectSealError(() => openBody(key, s.nonce, s.body, aad));
    }
  });

  it('safety code is order independent and always "123 456"', () => {
    for (let i = 0; i < 200; i++) {
      const a = generateSealKeyPair().publicKey;
      const b = generateSealKeyPair().publicKey;
      const code = safetyCode(a, b);
      expect(code).toMatch(/^\d{3} \d{3}$/);
      expect(safetyCode(b, a)).toBe(code);
    }
  });
});

describe('sealed chat schema edge cases', () => {
  const key0 = { device: 'dev_bbbbbbbbbbbbbbbbbbbb', wrapped: 'AAAA' };
  const env = (o: Record<string, unknown> = {}) => ({
    v: 1,
    sender_device: 'dev_aaaaaaaaaaaaaaaaaaaa',
    sender_seq: 1,
    nonce: 'A'.repeat(32),
    body: 'AAAA',
    keys: [key0],
    ...o,
  });
  const ok = (o: Record<string, unknown>) => sealedEnvelopeV1Schema.safeParse(env(o)).success;

  it('accepts only canonical 32-byte keys', () => {
    for (let i = 0; i < 100; i++) {
      const k = base64urlEncode(generateSealKeyPair().publicKey);
      expect(publicKeySchema.safeParse(k).success).toBe(true);
    }
    expect(publicKeySchema.safeParse('A'.repeat(42) + 'B').success).toBe(false);
    expect(publicKeySchema.safeParse('A'.repeat(42) + '_').success).toBe(false);
    expect(publicKeySchema.safeParse('A'.repeat(44)).success).toBe(false);
  });

  it('caps the envelope', () => {
    expect(ok({})).toBe(true);
    expect(ok({ keys: [] })).toBe(false);
    expect(ok({ keys: Array(MAX_PAIRED_DEVICES + 1).fill(key0) })).toBe(false);
    expect(ok({ body: 'A'.repeat(MAX_SEALED_BODY_CHARS + 1) })).toBe(false);
    expect(ok({ sender_seq: 0 })).toBe(false);
    expect(ok({ sender_seq: 1.5 })).toBe(false);
    expect(ok({ sender_seq: Number.MAX_SAFE_INTEGER + 2 })).toBe(false);
    expect(ok({ chunk: { index: -1, final: false } })).toBe(false);
    expect(ok({ chunk: { index: 0, final: false, x: 1 } })).toBe(false);
    expect(ok({ extra: 1 })).toBe(false);
    expect(ok({ keys: [{ ...key0, x: 1 }] })).toBe(false);
    expect(ok({ keys: [{ ...key0, wrapped: 'A'.repeat(129) }] })).toBe(false);
  });

  it('relay frames refuse an oversized sealed body', () => {
    const big = env({ body: 'A'.repeat(MAX_SEALED_BODY_CHARS + 1) });
    expect(
      relayGatewayMessageSchema.safeParse({
        type: 'sealed.message',
        agent: 'x',
        message_id: 'msg_aaaaaaaaaaaaaaaaaaaa',
        sealed: big,
      }).success,
    ).toBe(false);
    expect(
      relayConnectorMessageSchema.safeParse({
        type: 'sealed.reply',
        agent: 'x',
        turn_id: 't',
        sealed: env({ body: 'A'.repeat(MAX_SEALED_AGENT_BODY_CHARS + 1) }),
        final: true,
      }).success,
    ).toBe(false);
  });

  it('a sealed thread message never exposes text and needs its envelope', () => {
    const common = {
      id: 'msg_aaaaaaaaaaaaaaaaaaaa',
      thread_id: 'x',
      created_at: '2026-11-24T00:00:00.000Z',
    };
    const parsed = threadMessageSchema.safeParse({
      ...common,
      kind: 'sealed',
      author: 'user',
      sealed: env(),
      text: 'leak',
    });
    if (parsed.success) expect('text' in parsed.data).toBe(false);
    expect(
      threadMessageSchema.safeParse({ ...common, kind: 'sealed', author: 'user' }).success,
    ).toBe(false);
  });
});
