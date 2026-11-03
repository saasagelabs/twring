import { randomBytes } from '@noble/ciphers/utils.js';

import type { SealedEnvelope } from './selfhost';
import { sealWithNonce } from './seal-core';

export {
  MAX_SEAL_PLAINTEXT_BYTES,
  SealError,
  base64urlDecode,
  base64urlEncode,
  deriveSealKey,
  generateSealKeyPair,
  open,
} from './seal-core';

/** Seals under a fresh random 24-byte nonce. Throws SealError above MAX_SEAL_PLAINTEXT_BYTES. */
export function seal(key: Uint8Array, plaintext: Uint8Array): SealedEnvelope {
  return sealWithNonce(key, plaintext, randomBytes(24));
}
