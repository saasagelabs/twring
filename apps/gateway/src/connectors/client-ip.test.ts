import type { IncomingMessage } from 'node:http';

import { describe, expect, it } from 'vitest';

import { clientIp } from './routes';

const request = (remote: string, forwarded?: string) =>
  ({
    socket: { remoteAddress: remote },
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  }) as unknown as IncomingMessage;

describe('clientIp', () => {
  describe('hosted layout (proxy on the host, loopback peer)', () => {
    it.each([true, ['127.0.0.1']] as const)('trusts loopback with TRUST_PROXY=%j', (trust) => {
      expect(clientIp(request('127.0.0.1', '1.1.1.1, 9.9.9.9'), trust)).toBe('9.9.9.9');
      expect(clientIp(request('::ffff:127.0.0.1', '9.9.9.9'), trust)).toBe('9.9.9.9');
      expect(clientIp(request('::1', '9.9.9.9'), trust)).toBe('9.9.9.9');
    });

    it('ignores X-Forwarded-For from a non-loopback peer when TRUST_PROXY=true', () => {
      expect(clientIp(request('203.0.113.5', '9.9.9.9'), true)).toBe('203.0.113.5');
    });

    it('trusts nobody when TRUST_PROXY=false', () => {
      expect(clientIp(request('127.0.0.1', '9.9.9.9'), false)).toBe('127.0.0.1');
    });
  });

  describe('self-hosted layout (Caddy container at a listed address)', () => {
    const caddy = ['172.29.41.2'];

    it('takes the last hop Caddy added', () => {
      expect(clientIp(request('172.29.41.2', 'spoofed, 198.51.100.7'), caddy)).toBe('198.51.100.7');
      expect(clientIp(request('::ffff:172.29.41.2', '198.51.100.7'), caddy)).toBe('198.51.100.7');
    });

    it('ignores X-Forwarded-For from any other peer', () => {
      expect(clientIp(request('172.29.41.9', '198.51.100.7'), caddy)).toBe('172.29.41.9');
      expect(clientIp(request('203.0.113.5', '198.51.100.7'), caddy)).toBe('203.0.113.5');
    });

    it('matches subnets and IPv6 entries', () => {
      expect(clientIp(request('10.1.2.3', '198.51.100.7'), ['10.0.0.0/8'])).toBe('198.51.100.7');
      expect(clientIp(request('fd00::5', '198.51.100.7'), ['fd00::/64'])).toBe('198.51.100.7');
      expect(clientIp(request('fd01::5', '198.51.100.7'), ['fd00::/64'])).toBe('fd01::5');
    });

    it('falls back to the peer when the header is missing or empty', () => {
      expect(clientIp(request('172.29.41.2'), caddy)).toBe('172.29.41.2');
      expect(clientIp(request('172.29.41.2', ' '), caddy)).toBe('172.29.41.2');
    });
  });
});
