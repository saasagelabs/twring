import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import { pairingCodeSchema } from './connectors';
import { errorCodeSchema } from './errors';
import {
  base32Lower,
  buildPairLink,
  parsePairLink,
  pairRequestSchema,
  pairResponseSchema,
  RELAY_AUDIO_MAX_SESSION_SECONDS,
  RELAY_AUDIO_TOKEN_TTL_SECONDS,
  relayAudioRoom,
  relayAudioSessionRequestSchema,
  relayAudioSessionResponseSchema,
  relayCallerIdentity,
  relayDeviceRequestSchema,
  RELAY_INSTALL_PROOF_AUDIENCE,
  RELAY_INSTALL_PROOF_MAX_SECONDS,
  relayInstallProofClaims,
  relayInstallAddressRequestSchema,
  relayInstallRequestSchema,
  relayIpResponseSchema,
  PROBE_ECHO_PATTERN,
  probeEchoLine,
  relayProbeRequestSchema,
  relayProbeResponseSchema,
  relayPushRequestSchema,
  relayPushResponseSchema,
  sealedEnvelopeSchema,
  serverIdFor,
  serverIdSchema,
  serverInfoSchema,
} from './selfhost';

const KEY32 = 'A'.repeat(43);
const ENVELOPE = { v: 1, n: 'n'.repeat(32), c: 'c'.repeat(22) };
const SERVER = {
  server_id: `srv_${'a'.repeat(32)}`,
  name: 'Home',
  mode: 'selfhost',
  audio: 'own',
  ring_service: { state: 'active', paid_until: '2027-01-01T00:00:00.000Z' },
};

describe('pairingCodeSchema', () => {
  it('accepts XXXX-XXXX from the unambiguous alphabet', () => {
    expect(pairingCodeSchema.safeParse('K7QM-2XPA').success).toBe(true);
  });
  it.each(['K7QM2XPA', 'k7qm-2xpa', 'O0IL-1111', 'K7QM-2XP', 'K7QM-2XPAA'])('rejects %s', (v) => {
    expect(pairingCodeSchema.safeParse(v).success).toBe(false);
  });
});

describe('serverIdSchema', () => {
  it('accepts srv_ plus 32 base32 characters', () => {
    const id = `srv_${'abcdefghijklmnopqrstuvwxyz234567'}`;
    expect(serverIdSchema.safeParse(id).success).toBe(true);
  });
  it.each([
    `srv_${'a'.repeat(31)}`,
    `srv_${'a'.repeat(33)}`,
    `srv_${'1'.repeat(32)}`,
    'a'.repeat(36),
  ])('rejects %s', (v) => {
    expect(serverIdSchema.safeParse(v).success).toBe(false);
  });
});

describe('serverInfoSchema', () => {
  it('parses a self-hosted server and rejects another mode', () => {
    expect(serverInfoSchema.safeParse(SERVER).success).toBe(true);
    expect(serverInfoSchema.safeParse({ ...SERVER, mode: 'hosted' }).success).toBe(false);
  });
  it('ring service unknown carries no paid_until; known states require one', () => {
    const with_ = (ring_service: unknown) =>
      serverInfoSchema.safeParse({ ...SERVER, ring_service });
    expect(with_({ state: 'unknown' }).success).toBe(true);
    expect(with_({ state: 'unknown', paid_until: '2027-01-01T00:00:00.000Z' }).success).toBe(false);
    expect(with_({ state: 'active' }).success).toBe(false);
  });
  it('ring service unregistered (the relay no longer knows this server) carries no paid_until', () => {
    const with_ = (ring_service: unknown) =>
      serverInfoSchema.safeParse({ ...SERVER, ring_service });
    expect(with_({ state: 'unregistered' }).success).toBe(true);
    expect(with_({ state: 'unregistered', paid_until: '2027-01-01T00:00:00.000Z' }).success).toBe(
      false,
    );
  });
});

describe('pairRequestSchema', () => {
  const valid = {
    code: 'K7QM-2XPA',
    display_name: 'Asha',
    device_name: 'Pixel 9',
    platform: 'android',
    seal_public_key: KEY32,
  };
  const parse = (overrides: Record<string, unknown>) =>
    pairRequestSchema.safeParse({ ...valid, ...overrides }).success;

  it('accepts a valid request', () => {
    expect(pairRequestSchema.safeParse(valid).success).toBe(true);
  });
  it('is strict: an extra field is rejected', () => {
    expect(parse({ extra: 1 })).toBe(false);
  });
  it('needs a seal key of exactly 32 bytes', () => {
    expect(parse({ seal_public_key: 'A'.repeat(42) })).toBe(false);
    expect(parse({ seal_public_key: 'A'.repeat(44) })).toBe(false);
    expect(parse({ seal_public_key: `${'A'.repeat(42)}=` })).toBe(false);
  });
  it('bounds the names and the platform', () => {
    expect(parse({ display_name: '' })).toBe(false);
    expect(parse({ display_name: 'x'.repeat(41) })).toBe(false);
    expect(parse({ device_name: 'x'.repeat(61) })).toBe(false);
    expect(parse({ platform: 'web' })).toBe(false);
  });
});

describe('pairResponseSchema', () => {
  it('parses a pairing result', () => {
    const body = {
      person: { id: 'p1', display_name: 'Asha', role: 'admin' },
      device: { id: 'd1', token: `twd_${'x'.repeat(43)}` },
      server: SERVER,
      seal_server_public_key: KEY32,
    };
    expect(pairResponseSchema.safeParse(body).success).toBe(true);
    const badRole = { ...body, person: { ...body.person, role: 'owner' } };
    expect(pairResponseSchema.safeParse(badRole).success).toBe(false);
  });
});

describe('sealedEnvelopeSchema', () => {
  it('needs version 1', () => {
    expect(sealedEnvelopeSchema.safeParse(ENVELOPE).success).toBe(true);
    expect(sealedEnvelopeSchema.safeParse({ ...ENVELOPE, v: 2 }).success).toBe(false);
  });

  it('needs a 24-byte unpadded base64url nonce', () => {
    expect(sealedEnvelopeSchema.safeParse({ ...ENVELOPE, n: 'n'.repeat(31) }).success).toBe(false);
    expect(sealedEnvelopeSchema.safeParse({ ...ENVELOPE, n: 'n'.repeat(33) }).success).toBe(false);
    expect(sealedEnvelopeSchema.safeParse({ ...ENVELOPE, n: `${'n'.repeat(30)}==` }).success).toBe(
      false,
    );
  });

  it('needs ciphertext of at least the 16-byte tag, bounded, unpadded base64url', () => {
    expect(sealedEnvelopeSchema.safeParse({ ...ENVELOPE, c: 'c'.repeat(21) }).success).toBe(false);
    expect(sealedEnvelopeSchema.safeParse({ ...ENVELOPE, c: 'c'.repeat(3400) }).success).toBe(true);
    expect(sealedEnvelopeSchema.safeParse({ ...ENVELOPE, c: 'c'.repeat(3401) }).success).toBe(
      false,
    );
    expect(sealedEnvelopeSchema.safeParse({ ...ENVELOPE, c: `${'c'.repeat(22)}=` }).success).toBe(
      false,
    );
    expect(sealedEnvelopeSchema.safeParse({ ...ENVELOPE, c: `${'c'.repeat(21)}+` }).success).toBe(
      false,
    );
  });
});

describe('relayPushRequestSchema', () => {
  const valid = {
    handle: 'hnd_abc',
    kind: 'ring',
    sealed: ENVELOPE,
    ttl_seconds: 30,
    priority: 'high',
  };
  const parse = (overrides: Record<string, unknown>) =>
    relayPushRequestSchema.safeParse({ ...valid, ...overrides }).success;

  it.each(['ring', 'ring_cancel', 'message', 'missed_call'])('accepts kind %s', (kind) => {
    expect(parse({ kind })).toBe(true);
  });
  it('rejects an unknown kind and a ttl outside 1..3600', () => {
    expect(parse({ kind: 'spam' })).toBe(false);
    expect(parse({ ttl_seconds: 0 })).toBe(false);
    expect(parse({ ttl_seconds: 3601 })).toBe(false);
  });
});

describe('relay probe and audio schemas', () => {
  it('limits probe checks to the known set', () => {
    const base = { address: 'home.example.com', nonce: 'n1' };
    const all = ['https', 'http', 'tcp7881', 'udp7882'];
    expect(relayProbeRequestSchema.safeParse({ ...base, checks: all }).success).toBe(true);
    expect(relayProbeRequestSchema.safeParse({ ...base, checks: ['ssh'] }).success).toBe(false);
  });
  it('parses probe results keyed by check', () => {
    const ok = { results: { https: { ok: true, ms: 12 }, udp7882: { ok: false } } };
    expect(relayProbeResponseSchema.safeParse(ok).success).toBe(true);
    expect(relayProbeResponseSchema.safeParse({ results: { ssh: { ok: true } } }).success).toBe(
      false,
    );
  });
  it('takes a probe nonce of safe characters only', () => {
    const base = { address: 'home.example.com', checks: ['http'] };
    expect(relayProbeRequestSchema.safeParse({ ...base, nonce: 'aZ0_-' }).success).toBe(true);
    expect(relayProbeRequestSchema.safeParse({ ...base, nonce: 'a b' }).success).toBe(false);
    expect(relayProbeRequestSchema.safeParse({ ...base, nonce: 'a\n' }).success).toBe(false);
    expect(relayProbeRequestSchema.safeParse({ ...base, nonce: 'a'.repeat(65) }).success).toBe(
      false,
    );
  });
  it('builds and matches the echo line', () => {
    expect(probeEchoLine('abc')).toBe('twring-probe abc');
    expect(PROBE_ECHO_PATTERN.test('twring-probe abc')).toBe(true);
    expect(PROBE_ECHO_PATTERN.test('twring-probe a c')).toBe(false);
    expect(PROBE_ECHO_PATTERN.test('xtwring-probe abc')).toBe(false);
  });
  it('accepts a hostname, an IP or an https URL as the install address', () => {
    for (const address of [
      'home.example.com',
      '203.0.113.7',
      '2001:db8::1',
      'https://twring.example.com',
      'https://box.example.com:443',
      'https://[2001:db8::1]/',
    ]) {
      expect(relayInstallAddressRequestSchema.safeParse({ address }).success, address).toBe(true);
    }
    for (const address of [
      '',
      'http://home.example.com',
      'https://user:pw@home.example.com',
      'https://home.example.com/path?x=1',
      'home example.com',
      'home.example.com:22',
      'https://box.example.com:8443',
      'https://box.example.com:80',
      '-bad.example.com',
      'a'.repeat(254),
    ]) {
      expect(relayInstallAddressRequestSchema.safeParse({ address }).success, address).toBe(false);
    }
    expect(
      relayInstallAddressRequestSchema.safeParse({ address: 'a.example.com', x: 1 }).success,
    ).toBe(false);
  });
  it('validates the address given at registration too', () => {
    const base = {
      email: 'a@example.com',
      news: false,
      server_id: `srv_${'a'.repeat(32)}`,
      public_key: 'k',
      proof: 'p',
    };
    const ok = relayInstallRequestSchema.safeParse({ ...base, address: 'home.example.com' });
    const bad = relayInstallRequestSchema.safeParse({
      ...base,
      address: 'https://x.example.com:8443',
    });
    expect(ok.error?.issues.some((i) => i.path[0] === 'address') ?? false).toBe(false);
    expect(bad.error?.issues.some((i) => i.path[0] === 'address')).toBe(true);
  });
  it('parses the caller address answer', () => {
    expect(relayIpResponseSchema.safeParse({ ip: '203.0.113.7' }).success).toBe(true);
    expect(relayIpResponseSchema.safeParse({ ip: 'nope' }).success).toBe(false);
  });
  it('parses an audio session', () => {
    const session = {
      url: 'wss://audio.example.com',
      room: 'r1',
      caller_token: 'a',
      server_token: 'b',
      expires_at: '2027-01-01T00:00:00.000Z',
    };
    expect(relayAudioSessionResponseSchema.safeParse(session).success).toBe(true);
  });
});

describe('relay call audio', () => {
  it('accepts a call id only of room-safe characters, up to 64', () => {
    expect(relayAudioSessionRequestSchema.safeParse({ call_id: 'call_abc-2' }).success).toBe(true);
    for (const bad of ['', 'a/b', 'a b', 'x'.repeat(65), 'call_é']) {
      expect(relayAudioSessionRequestSchema.safeParse({ call_id: bad }).success, bad).toBe(false);
    }
  });
  it('tokens last 10 minutes; a session at most 2 hours', () => {
    expect(RELAY_AUDIO_TOKEN_TTL_SECONDS).toBe(600);
    expect(RELAY_AUDIO_MAX_SESSION_SECONDS).toBe(7200);
  });
  it('names the room under the install and the caller after the call', () => {
    expect(relayAudioRoom('ins_A', 'call_b')).toBe('inst_ins_A_call_b');
    expect(relayCallerIdentity('call_b')).toBe('caller-call_b');
  });
});

describe('self-hosted error codes', () => {
  it('include device_removed, forbidden, last_admin and the audio codes', () => {
    for (const code of [
      'device_removed',
      'forbidden',
      'last_admin',
      'audio_unavailable',
      'audio_unreachable',
      'audio_paused',
      'audio_expired',
      'audio_limit_reached',
    ]) {
      expect(errorCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });
});

describe('relayInstallRequestSchema', () => {
  const base = {
    email: 'owner@example.com',
    news: false,
    server_id: `srv_${'a'.repeat(32)}`,
    public_key: KEY32,
    proof: 'a.b.c',
  };

  it('accepts a request with a proof', () => {
    expect(relayInstallRequestSchema.safeParse(base).success).toBe(true);
  });

  it('requires the proof', () => {
    const rest: Record<string, unknown> = { ...base };
    delete rest.proof;
    expect(relayInstallRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects implausible and over-long email addresses', () => {
    for (const email of ['not-an-email', 'a@b', '@example.com', `${'a'.repeat(250)}@example.com`]) {
      expect(relayInstallRequestSchema.safeParse({ ...base, email }).success).toBe(false);
    }
  });
});

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

describe('serverIdFor', () => {
  it('base32 matches RFC 4648 vectors (lower case, no padding)', () => {
    expect(base32Lower(ascii('foobar'))).toBe('mzxw6ytboi');
    expect(base32Lower(ascii('f'))).toBe('my');
  });

  it('is srv_ + base32 of the first 20 bytes of SHA-256(public key)', () => {
    const key = new Uint8Array(32).fill(7);
    const id = serverIdFor(key);
    expect(id).toBe(`srv_${base32Lower(sha256(key).subarray(0, 20))}`);
    expect(serverIdSchema.safeParse(id).success).toBe(true);
  });
});

describe('relayInstallProofClaims', () => {
  it('signs every request field with audience, jti and a short life', () => {
    const claims = relayInstallProofClaims(
      {
        server_id: `srv_${'a'.repeat(32)}`,
        email: 'a@example.com',
        news: true,
        address: 'x.example',
      },
      { jti: 'j'.repeat(22), nowSeconds: 1000 },
    );
    expect(claims).toEqual({
      aud: RELAY_INSTALL_PROOF_AUDIENCE,
      server_id: `srv_${'a'.repeat(32)}`,
      email: 'a@example.com',
      news: true,
      address: 'x.example',
      jti: 'j'.repeat(22),
      iat: 1000,
      exp: 1300,
    });
    expect(RELAY_INSTALL_PROOF_AUDIENCE).toBe('twring-relay/installs');
  });

  it('caps the lifetime at the relay maximum', () => {
    const claims = relayInstallProofClaims(
      { server_id: 's', email: 'e', news: false },
      { jti: 'j', nowSeconds: 0, lifetimeSeconds: 10_000 },
    );
    expect(claims.exp).toBe(RELAY_INSTALL_PROOF_MAX_SECONDS);
    expect(claims).not.toHaveProperty('address');
  });
});

describe('relayDeviceRequestSchema', () => {
  const ticket = 'a.b.c';
  const FCM = 'fcm:token_value.1234567890-abc';
  const HEX = 'ab'.repeat(32);
  it('accepts an Android phone with its FCM token', () => {
    expect(
      relayDeviceRequestSchema.safeParse({ ticket, platform: 'android', fcm_token: FCM }).success,
    ).toBe(true);
  });
  it('accepts an iPhone with its VoIP token and optional alert token', () => {
    expect(
      relayDeviceRequestSchema.safeParse({ ticket, platform: 'ios', voip_token: HEX }).success,
    ).toBe(true);
    expect(
      relayDeviceRequestSchema.safeParse({
        ticket,
        platform: 'ios',
        voip_token: HEX,
        apns_token: HEX,
      }).success,
    ).toBe(true);
  });
  it('needs the ring token of the platform', () => {
    expect(relayDeviceRequestSchema.safeParse({ ticket, platform: 'android' }).success).toBe(false);
    expect(relayDeviceRequestSchema.safeParse({ ticket, platform: 'ios' }).success).toBe(false);
    expect(
      relayDeviceRequestSchema.safeParse({ ticket, platform: 'ios', apns_token: HEX }).success,
    ).toBe(false);
  });
  it('refuses tokens of the other platform', () => {
    for (const extra of [{ voip_token: HEX }, { apns_token: HEX }]) {
      expect(
        relayDeviceRequestSchema.safeParse({
          ticket,
          platform: 'android',
          fcm_token: FCM,
          ...extra,
        }).success,
      ).toBe(false);
    }
    expect(
      relayDeviceRequestSchema.safeParse({
        ticket,
        platform: 'ios',
        voip_token: HEX,
        fcm_token: FCM,
      }).success,
    ).toBe(false);
  });

  it('refuses malformed tokens and unknown fields', () => {
    const bad = [
      { platform: 'ios', voip_token: '../../etc/passwd' },
      { platform: 'ios', voip_token: HEX, apns_token: 'not hex' },
      { platform: 'android', fcm_token: 'short' },
      { platform: 'android', fcm_token: 'has/slash/in/it/123456789' },
      { platform: 'android', fcm_token: FCM, extra: 1 },
    ];
    for (const body of bad) {
      expect(relayDeviceRequestSchema.safeParse({ ticket, ...body }).success).toBe(false);
    }
  });
});

describe('relayPushResponseSchema', () => {
  it('has an unsupported outcome for pushes that can never be delivered', () => {
    expect(relayPushResponseSchema.parse({ outcome: 'unsupported' }).outcome).toBe('unsupported');
  });
});

describe('pair link', () => {
  const parts = {
    server: 'https://203-0-113-7.sslip.io',
    code: 'K7QM-2XPA',
    serverId: serverIdFor(new Uint8Array(32).fill(7)),
  };

  it('round-trips', () => {
    expect(buildPairLink(parts)).toBe(
      `twring://pair?server=https%3A%2F%2F203-0-113-7.sslip.io&code=K7QM-2XPA&id=${parts.serverId}`,
    );
    expect(parsePairLink(buildPairLink(parts))).toEqual(parts);
  });

  it('accepts any parameter order, ignores unknown ones, and normalizes the code', () => {
    const link = `twring://pair?id=${parts.serverId}&x=1&code=k7qm2xpa&server=${encodeURIComponent(parts.server)}`;
    expect(parsePairLink(link)).toEqual(parts);
  });

  it.each([
    ['http server', { server: 'http://203-0-113-7.sslip.io' }],
    ['server with a path', { server: 'https://a.example.com/x' }],
    ['bad code', { code: 'NOPE' }],
    ['bad id', { serverId: 'srv_nope' }],
  ])('refuses a %s', (_name, change) => {
    expect(parsePairLink(buildPairLink({ ...parts, ...change }))).toBeUndefined();
  });

  it('refuses another scheme and missing fields', () => {
    expect(parsePairLink(buildPairLink(parts).replace('twring', 'cord'))).toBeUndefined();
    expect(parsePairLink('twring://pair?server=https%3A%2F%2Fa.example.com')).toBeUndefined();
    expect(parsePairLink('hello')).toBeUndefined();
  });
});
