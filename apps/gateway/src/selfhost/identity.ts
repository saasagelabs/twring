import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { base32Lower, base64urlDecode, serverIdFor } from '@twring/contracts';
import { SignJWT, type JWTPayload } from 'jose';

/** This server's Ed25519 identity: the id phones check and the key that signs device tickets. */
export interface ServerIdentity {
  /** `srv_` + base32 of the first 20 bytes of SHA-256(raw public key). */
  id: string;
  publicKeyRaw: Uint8Array;
  /** A compact JWS (EdDSA) over `claims`. */
  sign(claims: JWTPayload): Promise<string>;
}

// One formula for the server and the relay: `srv_` + base32 of SHA-256(public key)[0..20].
export { base32Lower, serverIdFor };

/** Builds the identity from an Ed25519 private key. */
export function serverIdentityFromKey(privateKey: KeyObject): ServerIdentity {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('The server key must be an Ed25519 key.');
  }
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('The server key has no public part.');
  const publicKeyRaw = base64urlDecode(jwk.x);
  const id = serverIdFor(publicKeyRaw);
  return {
    id,
    publicKeyRaw,
    sign: (claims) =>
      new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' }).sign(privateKey),
  };
}

/** Reads the PKCS8 PEM in `TWRING_SERVER_KEY_FILE`. Never logs or returns the key itself. */
export async function loadServerIdentity(file: string): Promise<ServerIdentity> {
  const pem = await readFile(file, 'utf8');
  return serverIdentityFromKey(createPrivateKey({ key: pem, format: 'pem' }));
}
