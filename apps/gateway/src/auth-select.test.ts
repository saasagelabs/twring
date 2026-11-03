import { describe, expect, it } from 'vitest';

import { devAuthenticator, supabaseAuthenticator, selectAuthenticator } from './auth';

describe('selectAuthenticator', () => {
  it('uses the dev authenticator only for AUTH_MODE=dev', () => {
    expect(selectAuthenticator({ AUTH_MODE: 'dev' })).toBe(devAuthenticator);
  });
  it('builds the Supabase authenticator for supabase with a URL', () => {
    const auth = selectAuthenticator({
      AUTH_MODE: 'supabase',
      SUPABASE_URL: 'https://p.supabase.invalid',
    });
    expect(auth).not.toBe(devAuthenticator);
    expect(typeof auth).toBe('function');
    expect(supabaseAuthenticator).toBeTypeOf('function');
  });
  it('uses the pairing authenticator for pairing', () => {
    const authenticator = () => Promise.resolve('person-1');
    expect(selectAuthenticator({ AUTH_MODE: 'pairing' }, { authenticator })).toBe(authenticator);
  });
  it('fails closed for pairing without the paired-phone store', () => {
    expect(() => selectAuthenticator({ AUTH_MODE: 'pairing' })).toThrow(/paired-phone store/);
  });
  it('fails closed for supabase without a URL', () => {
    expect(() => selectAuthenticator({ AUTH_MODE: 'supabase' })).toThrow(/SUPABASE_URL/);
  });
});
