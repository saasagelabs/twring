import { getRandomValues } from 'expo-crypto';

type IntArray =
  Int8Array | Int16Array | Int32Array | Uint8Array | Uint16Array | Uint32Array | Uint8ClampedArray;

interface CryptoHolder {
  crypto?: { getRandomValues?: <T extends IntArray>(array: T) => T };
}

/**
 * Supabase's PKCE sign-in (Google on the iPhone) calls `crypto.getRandomValues` whenever a global
 * `crypto` exists. React Native has none, and LiveKit's `registerGlobals` creates one with only
 * `randomUUID`, so the call threw and "Continue with Google" failed before its sheet opened. This
 * fills in `getRandomValues` from expo-crypto (secure random). `crypto.subtle` is left alone:
 * other code reads its presence as full Web Crypto; Supabase then uses a plain PKCE challenge,
 * which is safe here because Apple's sign-in sheet returns the code straight to the app.
 */
export function installRandomValues(
  target: CryptoHolder = globalThis as CryptoHolder,
  random: <T extends IntArray>(array: T) => T = getRandomValues,
): void {
  const crypto = target.crypto ?? {};
  if (typeof crypto.getRandomValues !== 'function') crypto.getRandomValues = random;
  target.crypto = crypto;
}
