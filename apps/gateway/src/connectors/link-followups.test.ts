import {
  createLinkResponseSchema,
  errorResponseSchema,
  linkPollResponseSchema,
  type CreateLinkResponse,
} from '@twring/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createRequestAuth } from '../auth';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { ipKey, LINK_TTL_MS, LinkBook, ownerDisplayName, REDELIVERY_MS } from './link-requests';

/** Follow-ups to computer-first linking (ADR-025): owner name, redelivery, cancel, limits. */

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway(options: Parameters<typeof startConnectorGateway>[0] = {}) {
  const g = await startConnectorGateway(options);
  gateways.push(g);
  return g;
}

const AGENTS = [{ local_agent: 'claude-code', kind: 'claude-code', label: 'Claude Code' }];
const CODEX = [{ local_agent: 'codex', kind: 'codex' as const, label: 'Codex' }];
const EXPIRED = 'That code expired. Get a new code on your computer and try again.';

async function ask(g: ConnectorGateway, ip?: string) {
  const res = await g.send('POST', '/v1/connectors/link-requests', {
    body: { computer_name: 'Studio Mac', agents: AGENTS },
    ...(ip !== undefined && { ip }),
  });
  return res;
}

async function asked(g: ConnectorGateway, ip?: string): Promise<CreateLinkResponse> {
  const res = await ask(g, ip);
  expect(res.statusCode, res.body).toBe(201);
  return createLinkResponseSchema.parse(res.json());
}

const auth = (link: CreateLinkResponse, token = link.poll_token) => ({
  headers: { authorization: `Bearer ${token}` },
});
const poll = (g: ConnectorGateway, link: CreateLinkResponse) =>
  g.send('GET', `/v1/connectors/link-requests/${link.request_id}?wait=0`, auth(link));
const cancel = (g: ConnectorGateway, link: CreateLinkResponse, token = link.poll_token) =>
  g.send('DELETE', `/v1/connectors/link-requests/${link.request_id}`, auth(link, token));

describe('the account a computer joined', () => {
  it('names the owner by display name, else by masked email, else not at all', () => {
    expect(ownerDisplayName({ name: 'Ada Lovelace', email: 'g@example.com' })).toBe('Ada Lovelace');
    expect(ownerDisplayName({ email: 'owner@example.com' })).toBe('o***@example.com');
    expect(ownerDisplayName({ name: '  ', email: 'x@y.org' })).toBe('x***@y.org');
    expect(ownerDisplayName({ name: 'Eve‮\u0007' })).toBe('Eve');
    expect(ownerDisplayName({ email: 'not-an-email' })).toBeUndefined();
    expect(ownerDisplayName({})).toBeUndefined();
    expect([...ownerDisplayName({ name: '😀'.repeat(100) })!]).toHaveLength(60);
  });

  it('keeps the name and email the sign-in verified for the request', async () => {
    const auth = createRequestAuth(() =>
      Promise.resolve({ id: 'u1', name: 'Alice', email: 'a@x.org' }),
    );
    const request = { routeOptions: { url: '/v1/me' }, id: 'r1' } as unknown as FastifyRequest;
    await auth.hook(request, {} as FastifyReply);
    expect(auth.userFor(request)).toBe('u1');
    expect(auth.profileFor(request)).toEqual({ name: 'Alice', email: 'a@x.org' });
    const plain = createRequestAuth(() => Promise.resolve('u2'));
    await plain.hook(request, {} as FastifyReply);
    expect(plain.profileFor(request)).toEqual({});
  });

  it('tells the computer whose account approved it', async () => {
    const g = await gateway();
    const link = await asked(g);
    const ok = await g.send('POST', `/v1/link-requests/${link.code}/approve`, {
      user: 'alice',
      headers: { 'x-user-email': 'alice@example.com' },
    });
    expect(ok.statusCode).toBe(200);
    const answer = linkPollResponseSchema.parse((await poll(g, link)).json());
    expect(answer).toMatchObject({ status: 'approved', owner_name: 'a***@example.com' });
  });

  it('uses the display name when the sign-in has one', async () => {
    const g = await gateway();
    const link = await asked(g);
    await g.send('POST', `/v1/link-requests/${link.code}/approve`, {
      user: 'alice',
      headers: { 'x-user-name': 'Alice Liddell', 'x-user-email': 'alice@example.com' },
    });
    expect(linkPollResponseSchema.parse((await poll(g, link)).json())).toMatchObject({
      owner_name: 'Alice Liddell',
    });
  });
});

describe('redelivering an approval', () => {
  it('hands the same answer to the same token for a minute after the first delivery, then forgets', () => {
    let clock = 0;
    const book = new LinkBook(() => clock);
    const created = book.create('ip', 'Mac', CODEX);
    if (!created.ok) throw new Error('not created');
    const other = book.create('ip2', 'Mac', CODEX);
    if (!other.ok) throw new Error('not created');
    const taken = book.beginApprove(created.request.code, 'alice')!;
    book.approved(taken, `con_${'a'.repeat(20)}`, `cct_${'t'.repeat(43)}`, 'Alice');
    clock += 30_000;
    const first = book.poll(created.request.id, created.pollToken);
    expect(first).toMatchObject({ status: 'approved', owner_name: 'Alice' });
    // The delivery was lost; the computer asks again just inside the minute.
    clock += REDELIVERY_MS - 1;
    expect(book.poll(created.request.id, created.pollToken)).toEqual(first);
    // Never to another token.
    expect(book.poll(created.request.id, other.pollToken)).toBeUndefined();
    clock += 1;
    expect(book.poll(created.request.id, created.pollToken)).toBeUndefined();
  });

  it('sweeps a delivered approval after the minute even if nobody asks again', () => {
    let clock = 0;
    const book = new LinkBook(() => clock);
    const created = book.create('ip', 'Mac', CODEX);
    if (!created.ok) throw new Error('not created');
    book.approved(book.beginApprove(created.request.code, 'alice')!, 'c', 't');
    book.poll(created.request.id, created.pollToken);
    clock += REDELIVERY_MS;
    book.create('ip2', 'Mac', CODEX); // sweeps
    expect(book.poll(created.request.id, created.pollToken)).toBeUndefined();
  });
});

describe('the computer cancelling', () => {
  it('cancels with its poll token; the phone then hears expired, exactly', async () => {
    const g = await gateway();
    const link = await asked(g);
    const someone = await asked(g, '198.51.100.7');
    expect((await cancel(g, link, someone.poll_token)).statusCode).toBe(404);
    expect(
      (await g.send('DELETE', `/v1/connectors/link-requests/${link.request_id}`)).statusCode,
    ).toBe(401);
    expect((await cancel(g, link)).statusCode).toBe(204);

    const lookup = await g.send('GET', `/v1/link-requests/${link.code}`, { user: 'alice' });
    expect(lookup.statusCode).toBe(410);
    expect(errorResponseSchema.parse(lookup.json()).error).toMatchObject({
      code: 'pairing_invalid',
      message: EXPIRED,
    });
    const approve = await g.send('POST', `/v1/link-requests/${link.code}/approve`, {
      user: 'alice',
    });
    expect(approve.statusCode).toBe(410);
    expect(errorResponseSchema.parse(approve.json()).error.message).toBe(EXPIRED);
    expect((await poll(g, link)).json()).toEqual({ status: 'expired' });
    expect((await g.stores.connectors.list('alice')).length).toBe(0);
  });

  it('answers 404 for an unknown or malformed id', async () => {
    const g = await gateway();
    const link = await asked(g);
    const res = await g.send('DELETE', '/v1/connectors/link-requests/nope', auth(link));
    expect(res.statusCode).toBe(404);
  });
});

describe('expired codes are not wrong guesses', () => {
  it('lets a user look up and approve expired or cancelled codes without being locked out', async () => {
    let clock = Date.parse('2026-10-01T09:00:00.000Z');
    const g = await gateway({ links: new LinkBook(() => clock), linkGuessesPerHour: 1 });
    const cancelled = await asked(g);
    expect((await cancel(g, cancelled)).statusCode).toBe(204);
    const expired = await asked(g);
    clock += LINK_TTL_MS + 1;
    // Many tries across users from one address: the per-IP limit (30) would trip too.
    for (let i = 0; i < 40; i += 1) {
      for (const link of [cancelled, expired]) {
        const user = `user-${i}`;
        const res =
          i % 2 === 0
            ? await g.send('GET', `/v1/link-requests/${link.code}`, { user })
            : await g.send('POST', `/v1/link-requests/${link.code}/approve`, { user });
        expect(res.statusCode).toBe(410);
      }
    }
    // A real wrong guess still counts (and is the first for user-0).
    const wrong = await g.send('GET', '/v1/link-requests/ABCD-EFGH', { user: 'user-0' });
    expect(wrong.statusCode).toBe(400);
    expect(
      (await g.send('GET', '/v1/link-requests/ABCD-EFGH', { user: 'user-0' })).statusCode,
    ).toBe(429);
  });
});

describe('per-address keys', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['::FFFF:203.0.113.9', '203.0.113.9'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::9', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:ffff::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['64:ff9b::192.0.2.1', '64:ff9b:0:0::/64'],
  ])('keys %s as %s', (ip, key) => {
    expect(ipKey(ip)).toBe(key);
  });

  it('limits link requests per IPv6 /64, not per address', async () => {
    const g = await gateway({ linkCreatePerHour: 2 });
    expect((await ask(g, '2001:db8:1:2::1')).statusCode).toBe(201);
    expect((await ask(g, '2001:db8:1:2::2')).statusCode).toBe(201);
    expect((await ask(g, '2001:db8:1:2:ffff::3')).statusCode).toBe(429);
    expect((await ask(g, '2001:db8:1:3::1')).statusCode).toBe(201);
  });

  it('counts an IPv4-mapped address as its IPv4 address', async () => {
    const g = await gateway({ linkCreatePerHour: 1 });
    expect((await ask(g, '198.51.100.20')).statusCode).toBe(201);
    expect((await ask(g, '::ffff:198.51.100.20')).statusCode).toBe(429);
  });

  it('caps open requests per /64', () => {
    const book = new LinkBook();
    const ids: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const created = book.create(ipKey(`2001:db8::${i}`), 'Mac', CODEX);
      if (!created.ok) throw new Error('not created');
      ids.push(created.request.code);
    }
    // The oldest of the six from one /64 was dropped.
    expect(book.pendingByCode(ids[0]!)).toBeUndefined();
    expect(book.pendingByCode(ids[5]!)).toBeDefined();
  });
});

describe('deleting my data', () => {
  it('drops an approval the computer has not collected', async () => {
    const g = await gateway();
    const link = await asked(g);
    const ok = await g.send('POST', `/v1/link-requests/${link.code}/approve`, { user: 'alice' });
    expect(ok.statusCode).toBe(200);
    expect((await g.send('DELETE', '/v1/me/data', { user: 'alice' })).statusCode).toBe(200);
    expect((await poll(g, link)).statusCode).toBe(404);
  });
});
