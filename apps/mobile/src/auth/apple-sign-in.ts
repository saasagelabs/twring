import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';

import { AppleSignInError, type AppleSignIn } from './controller';

/** A fresh random nonce and its SHA-256: Apple signs the hash, Supabase checks the raw value. */
export async function appleNonce(): Promise<{ raw: string; hashed: string }> {
  const raw = `${Crypto.randomUUID()}${Crypto.randomUUID()}`.replace(/-/g, '');
  const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw);
  return { raw, hashed };
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/**
 * A fresh authorization code from Apple, to end Sign in with Apple when the account is deleted
 * (S3). Undefined when the person closes Apple's sheet; other failures throw.
 */
export async function appleAuthorizationCode(): Promise<string | undefined> {
  try {
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    return credential.authorizationCode ?? undefined;
  } catch (error) {
    if (errorCode(error) === 'ERR_REQUEST_CANCELED') return undefined;
    throw new AppleSignInError('failed');
  }
}

/** Sign in with Apple on the iPhone. */
export const appleSignIn: AppleSignIn = {
  async signIn() {
    const nonce = await appleNonce();
    let credential: AppleAuthentication.AppleAuthenticationCredential;
    try {
      credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: nonce.hashed,
      });
    } catch (error) {
      if (errorCode(error) === 'ERR_REQUEST_CANCELED') return { type: 'cancelled' };
      throw new AppleSignInError('failed');
    }
    const parts = credential.fullName;
    const full = parts ? AppleAuthentication.formatFullName(parts).trim() : '';
    return {
      type: 'success',
      idToken: credential.identityToken,
      nonce: nonce.raw,
      ...(full !== '' && {
        name: {
          full,
          ...(parts?.givenName && { given: parts.givenName }),
          ...(parts?.familyName && { family: parts.familyName }),
        },
      }),
    };
  },
};
