import { describe, expect, it } from 'vitest';

import { normalizeAddress } from './address';

const ok = (text: string, allowHttp = false) => normalizeAddress(text, { allowHttp });

describe('normalizeAddress', () => {
  it('lower-cases and drops the trailing slash', () => {
    expect(ok('HTTPS://Example.COM/')).toEqual({ ok: true, address: 'https://example.com' });
  });

  it('keeps a port', () => {
    expect(ok('https://h:8443')).toEqual({ ok: true, address: 'https://h:8443' });
  });

  it('turns a bare host into https', () => {
    expect(ok('example.com')).toEqual({ ok: true, address: 'https://example.com' });
    expect(ok('  example.com:8443 ')).toEqual({ ok: true, address: 'https://example.com:8443' });
  });

  it('refuses http unless allowed', () => {
    expect(ok('http://h')).toEqual({ ok: false, message: 'The address must start with https://' });
    expect(ok('http://h', true)).toEqual({ ok: true, address: 'http://h' });
  });

  it('accepts an IPv4 literal', () => {
    expect(ok('https://10.0.0.5:8443')).toEqual({ ok: true, address: 'https://10.0.0.5:8443' });
  });

  it.each([
    'https://h/path',
    'https://h/?q=1',
    'https://h?q=1',
    'https://h#frag',
    'https://user:pw@h',
    'https://user@h',
    'https://h:0',
    'https://h:65536',
    'https://h:99999',
    'https://h:',
    'https://-bad.example.com',
    'https://bad_host.example.com',
    'https://exa mple.com',
    'ftp://h',
    '',
    '   ',
  ])('refuses %j', (text) => {
    expect(ok(text, true).ok).toBe(false);
  });
});
