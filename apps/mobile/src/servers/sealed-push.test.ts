import { base64urlEncode, seal } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { openSealedPush, openedSealedRoute } from './sealed-push';

const key = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const otherKey = Uint8Array.from({ length: 32 }, (_, i) => i + 90);
const now = Date.parse('2026-10-31T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

const message = (over: Record<string, unknown> = {}) => ({
  kind: 'message',
  type: 'cord.message',
  id: 'msg_1',
  message_id: 'msg_1',
  agent_id: 'agt_1',
  issued_at: iso(-1000),
  ...over,
});
const ring = (over: Record<string, unknown> = {}) => ({
  kind: 'ring',
  type: 'cord.ring',
  id: 'inv_1',
  invite_id: 'inv_1',
  issued_at: iso(-1000),
  ...over,
});
const missed = (over: Record<string, unknown> = {}) => ({
  kind: 'missed_call',
  type: 'cord.ring_cancel',
  status: 'missed',
  id: 'inv_1',
  invite_id: 'inv_1',
  issued_at: iso(-1000),
  ...over,
});

function push(kind: string, inner: unknown, sealKey = key) {
  const plaintext = typeof inner === 'string' ? inner : JSON.stringify(inner);
  return { kind, sealed: JSON.stringify(seal(sealKey, new TextEncoder().encode(plaintext))) };
}
const open = (data: Record<string, string>, keys = [key]) => openSealedPush(data, keys, now);

describe('openSealedPush', () => {
  it('opens a message, a ring and a missed call', () => {
    expect(open(push('message', message()))).toMatchObject({
      type: 'cord.message',
      agent_id: 'agt_1',
    });
    expect(open(push('ring', ring()))).toMatchObject({ type: 'cord.ring' });
    expect(open(push('missed_call', missed()))).toMatchObject({ status: 'missed' });
    expect(
      open(push('ring_cancel', { ...missed(), kind: 'ring_cancel', status: 'x' })),
    ).toBeDefined();
  });

  it('drops kind, id and issued_at from the opened push', () => {
    const inner = open(push('message', message()));
    expect(inner).not.toHaveProperty('kind');
    expect(inner).not.toHaveProperty('id');
    expect(inner).not.toHaveProperty('issued_at');
  });

  it('tries each stored key', () => {
    expect(open(push('message', message(), otherKey), [key, otherKey])).toBeDefined();
  });

  it('refuses what does not open or check out', () => {
    const m = message();
    expect(open(push('message', m, otherKey))).toBeUndefined();
    expect(open({ kind: 'message' })).toBeUndefined();
    expect(open({ sealed: push('message', m).sealed })).toBeUndefined();
    expect(open({ kind: 'bogus', sealed: push('message', m).sealed })).toBeUndefined();
    expect(open({ kind: 'message', sealed: 'not json' })).toBeUndefined();
    expect(
      open({ kind: 'message', sealed: JSON.stringify({ v: 2, n: 'a', c: 'b' }) }),
    ).toBeUndefined();
    expect(open(push('message', 'not json'))).toBeUndefined();
    expect(open(push('message', '[1]'))).toBeUndefined();
    expect(open(push('message', message({ kind: 'ring' })))).toBeUndefined();
    expect(open(push('message', message({ type: 'cord.ring' })))).toBeUndefined();
    expect(open(push('missed_call', missed({ status: 'cancelled' })))).toBeUndefined();
    expect(open(push('message', message({ id: '', message_id: '' })))).toBeUndefined();
    expect(open(push('message', message({ message_id: 'other' })))).toBeUndefined();
    expect(open(push('message', message({ id: null, message_id: null })))).toBeUndefined();
    expect(open(push('ring', ring({ invite_id: null, id: null })))).toBeUndefined();
    expect(open(push('message', message({ issued_at: 'yesterday' })))).toBeUndefined();
    expect(open(push('message', message({ issued_at: undefined })))).toBeUndefined();
  });

  it('enforces the freshness window', () => {
    expect(open(push('message', message({ issued_at: iso(10 * 60_000) })))).toBeDefined();
    expect(open(push('message', message({ issued_at: iso(10 * 60_000 + 1) })))).toBeUndefined();
    expect(open(push('ring', ring({ issued_at: iso(-5 * 60_000) })))).toBeDefined();
    expect(open(push('ring', ring({ issued_at: iso(-5 * 60_000 - 1) })))).toBeUndefined();
    expect(open(push('message', message({ issued_at: iso(-24 * 3_600_000) })))).toBeDefined();
    expect(open(push('message', message({ issued_at: iso(-24 * 3_600_000 - 1) })))).toBeUndefined();
  });
});

describe('openedSealedRoute', () => {
  const secrets = () => Promise.resolve({ deviceToken: 't', sealKey: base64urlEncode(key) });
  const deps = (over = {}) => ({
    active: () => ({ kind: 'selfhost', serverId: 'srv_1' }) as const,
    secrets,
    now: () => now,
    ...over,
  });
  const tapped = (kind: string, inner: unknown, sealKey = key) => ({
    type: 'cord.sealed',
    ...push(kind, inner, sealKey),
  });

  it('opens a message in its chat and a missed call in history', async () => {
    expect(await openedSealedRoute(tapped('message', message()), deps())).toEqual({
      pathname: '/chats/[agentId]',
      params: { agentId: 'agt_1' },
    });
    expect(await openedSealedRoute(tapped('missed_call', missed()), deps())).toEqual({
      pathname: '/history',
    });
  });

  it('opens the app on its home screen for another server, a stale one, or Twring itself', async () => {
    expect(await openedSealedRoute(tapped('message', message(), otherKey), deps())).toBeUndefined();
    const stale = message({ issued_at: iso(-25 * 3_600_000) });
    expect(await openedSealedRoute(tapped('message', stale), deps())).toBeUndefined();
    expect(
      await openedSealedRoute(
        tapped('message', message()),
        deps({ active: () => ({ kind: 'hosted' }) }),
      ),
    ).toBeUndefined();
    expect(
      await openedSealedRoute(
        tapped('message', message()),
        deps({ secrets: () => Promise.resolve(undefined) }),
      ),
    ).toBeUndefined();
    expect(
      await openedSealedRoute(
        tapped('message', message()),
        deps({ secrets: async () => Promise.reject(new Error('x')) }),
      ),
    ).toBeUndefined();
  });
});
