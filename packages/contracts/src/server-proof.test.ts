import { ed25519 } from '@noble/curves/ed25519.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { base64urlEncode } from './seal-core';
import { serverIdFor } from './selfhost';
import {
  SERVER_PROOF_AUDIENCE,
  serverNonceSchema,
  serverProofInfoSchema,
  verifyServerProof,
} from './server-proof';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const NONCE = 'AbCdEfGhIjKlMnOpQrStUv';
const text = (value: unknown) => base64urlEncode(utf8ToBytes(JSON.stringify(value)));

function server(secret = ed25519.utils.randomSecretKey()) {
  const publicKey = ed25519.getPublicKey(secret);
  const sign = (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const input = `${text({ alg: 'EdDSA', typ: 'JWT', ...header })}.${text(claims)}`;
    return `${input}.${base64urlEncode(ed25519.sign(utf8ToBytes(input), secret))}`;
  };
  return { id: serverIdFor(publicKey), publicKey: base64urlEncode(publicKey), sign };
}

function answer(s: ReturnType<typeof server>, claims: Record<string, unknown> = {}) {
  return {
    server_id: s.id,
    public_key: s.publicKey,
    proof: s.sign({
      aud: SERVER_PROOF_AUDIENCE,
      server_id: s.id,
      nonce: NONCE,
      iat: Math.floor(NOW / 1000),
      ...claims,
    }),
  };
}

describe('verifyServerProof', () => {
  it('accepts a proof by the key whose id it claims, for this nonce, now', () => {
    const s = server();
    expect(verifyServerProof(answer(s), { nonce: NONCE, nowMs: NOW, serverId: s.id })).toEqual({
      ok: true,
    });
  });

  it('refuses a valid proof from another server than the one the QR named', () => {
    const qr = server();
    const other = server();
    expect(verifyServerProof(answer(other), { nonce: NONCE, nowMs: NOW, serverId: qr.id })).toEqual(
      {
        ok: false,
        reason: 'wrong_server',
      },
    );
  });

  it('refuses a forged id: another key signs a proof claiming the real id', () => {
    const real = server();
    const forger = server();
    const forged = {
      server_id: real.id,
      public_key: forger.publicKey,
      proof: forger.sign({
        aud: SERVER_PROOF_AUDIENCE,
        server_id: real.id,
        nonce: NONCE,
        iat: Math.floor(NOW / 1000),
      }),
    };
    expect(verifyServerProof(forged, { nonce: NONCE, nowMs: NOW, serverId: real.id })).toEqual({
      ok: false,
      reason: 'id_mismatch',
    });
  });

  it('refuses the real key and id with a signature from another key', () => {
    const real = server();
    const forger = server();
    const forged = {
      ...answer(real),
      proof: forger.sign({
        aud: SERVER_PROOF_AUDIENCE,
        server_id: real.id,
        nonce: NONCE,
        iat: Math.floor(NOW / 1000),
      }),
    };
    expect(verifyServerProof(forged, { nonce: NONCE, nowMs: NOW, serverId: real.id })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses another nonce, audience, id claim, algorithm, and an old or future iat', () => {
    const s = server();
    const check = (info: ReturnType<typeof answer>) =>
      verifyServerProof(info, { nonce: NONCE, nowMs: NOW, serverId: s.id });
    expect(check(answer(s, { nonce: 'OtherNonceOtherNonce12' }))).toMatchObject({ ok: false });
    expect(check(answer(s, { aud: 'someone-else' }))).toMatchObject({ ok: false });
    expect(check(answer(s, { server_id: server().id }))).toMatchObject({ ok: false });
    expect(check(answer(s, { iat: Math.floor(NOW / 1000) - 301 }))).toMatchObject({ ok: false });
    expect(check(answer(s, { iat: Math.floor(NOW / 1000) + 301 }))).toMatchObject({ ok: false });
    const none = { ...answer(s), proof: answer(s).proof.replace(/^[^.]+/, text({ alg: 'none' })) };
    expect(check(none)).toMatchObject({ ok: false });
  });

  it('refuses a missing proof and garbage without throwing', () => {
    const s = server();
    expect(
      verifyServerProof({ server_id: s.id }, { nonce: NONCE, nowMs: NOW, serverId: s.id }),
    ).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(
      verifyServerProof(
        { server_id: s.id, public_key: s.publicKey, proof: 'a.b.c' },
        { nonce: NONCE, nowMs: NOW, serverId: s.id },
      ),
    ).toMatchObject({ ok: false });
  });
});

describe('server proof schemas', () => {
  it('a nonce is 16 to 64 base64url characters', () => {
    expect(serverNonceSchema.safeParse(NONCE).success).toBe(true);
    expect(serverNonceSchema.safeParse('short').success).toBe(false);
    expect(serverNonceSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(serverNonceSchema.safeParse('has space in it here!').success).toBe(false);
  });

  it('the proof fields are optional on the server info', () => {
    const s = server();
    expect(serverProofInfoSchema.safeParse(answer(s)).success).toBe(true);
    expect(serverProofInfoSchema.safeParse({ server_id: s.id }).success).toBe(true);
  });
});
