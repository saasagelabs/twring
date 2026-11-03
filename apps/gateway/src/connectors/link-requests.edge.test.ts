import {
  connectorListResponseSchema,
  createLinkResponseSchema,
  errorResponseSchema,
  linkApproveResponseSchema,
  linkPollResponseSchema,
  type CreateLinkResponse,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { LOG_SERIALIZERS } from '../logger';
import { safeUrl } from '../redact';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { LINK_TTL_MS, LinkBook, MAX_OPEN_LINKS, MAX_OPEN_LINKS_PER_IP } from './link-requests';

/** Edge cases for computer-first linking (ADR-025): races, reconnects, limits, and leaks. */

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

async function ask(g: ConnectorGateway, ip?: string): Promise<CreateLinkResponse> {
  const res = await g.send('POST', '/v1/connectors/link-requests', {
    body: { computer_name: 'Studio Mac', agents: AGENTS },
    ...(ip !== undefined && { ip }),
  });
  expect(res.statusCode, res.body).toBe(201);
  return createLinkResponseSchema.parse(res.json());
}

function poll(g: ConnectorGateway, link: CreateLinkResponse, wait = 0, token = link.poll_token) {
  return g.send('GET', `/v1/connectors/link-requests/${link.request_id}?wait=${wait}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

const approve = (g: ConnectorGateway, code: string, user: string, ip?: string) =>
  g.send('POST', `/v1/link-requests/${code}/approve`, { user, ...(ip !== undefined && { ip }) });

/** The gateway's own HTTP address (the harness listens on a real port for the relay socket). */
const httpBase = (g: ConnectorGateway) => g.socketUrl.replace(/^ws:/, 'http:').split('/v1/')[0]!;

describe('link names', () => {
  it.each([
    ['right-to-left mark', 'Work\u200flaptop'],
    ['left-to-right mark', 'Work\u200elaptop'],
    ['Arabic letter mark', 'Work\u061claptop'],
    ['zero-width space', 'Work\u200blaptop'],
    ['word joiner', 'Work\u2060laptop'],
    // (A leading one is trimmed like a space.)
    ['byte order mark', 'Work\ufefflaptop'],
  ])('refuses a computer name with a %s', async (_what, name) => {
    const g = await gateway();
    const res = await g.send('POST', '/v1/connectors/link-requests', {
      body: { computer_name: name, agents: AGENTS },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an agent label hiding a bidi mark', async () => {
    const g = await gateway();
    const res = await g.send('POST', '/v1/connectors/link-requests', {
      body: {
        computer_name: 'Mac',
        agents: [{ local_agent: 'codex', kind: 'codex', label: 'Codex\u200f' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('shows markup as plain text, never refuses an ordinary name', async () => {
    const g = await gateway();
    const res = await g.send('POST', '/v1/connectors/link-requests', {
      body: { computer_name: '<b>Mac</b> & "Co"', agents: AGENTS },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('link code guessing', () => {
  it('limits wrong codes per address as well as per user', async () => {
    const g = await gateway();
    const ip = '198.51.100.40';
    const statuses: number[] = [];
    // Many accounts from one address each spend their own per-user allowance.
    for (let user = 0; user < 6; user += 1) {
      for (let i = 0; i < 10; i += 1) {
        const res = await g.send('GET', '/v1/link-requests/AAAA-AAAA', { user: `u${user}`, ip });
        statuses.push(res.statusCode);
      }
    }
    expect(statuses).toContain(429);
    // Another address is unaffected.
    const elsewhere = await g.send('GET', '/v1/link-requests/AAAA-AAAA', {
      user: 'fresh',
      ip: '198.51.100.41',
    });
    expect(elsewhere.statusCode).toBe(400);
  });

  it('does not count a right code as a wrong guess', async () => {
    const g = await gateway({ linkGuessesPerHour: 1 });
    for (let i = 0; i < 3; i += 1) {
      const link = await ask(g, `198.51.100.${50 + i}`);
      const res = await g.send('GET', `/v1/link-requests/${link.code}`, { user: 'alice' });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('approving', () => {
  it('lets exactly one of two users approve the same code at once', async () => {
    const g = await gateway();
    const link = await ask(g);
    const [a, b] = await Promise.all([
      approve(g, link.code, 'alice'),
      approve(g, link.code, 'bob'),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const owners = await Promise.all(
      ['alice', 'bob'].map(
        async (user) =>
          connectorListResponseSchema.parse(
            (await g.send('GET', '/v1/connectors', { user })).json(),
          ).connectors.length,
      ),
    );
    expect(owners.reduce((x, y) => x + y)).toBe(1);
  });

  it('answers a repeated approval from the same phone with the same computer', async () => {
    // The phone's first answer was lost on a bad network; it taps Link again.
    const g = await gateway();
    const link = await ask(g);
    const first = await approve(g, link.code, 'alice');
    expect(first.statusCode).toBe(200);
    const again = await approve(g, link.code, 'alice');
    expect(again.statusCode, again.body).toBe(200);
    expect(linkApproveResponseSchema.parse(again.json()).connector_id).toBe(
      linkApproveResponseSchema.parse(first.json()).connector_id,
    );
    // Still one computer, and still nobody else's.
    const mine = connectorListResponseSchema.parse(
      (await g.send('GET', '/v1/connectors', { user: 'alice' })).json(),
    );
    expect(mine.connectors).toHaveLength(1);
    expect((await approve(g, link.code, 'bob')).statusCode).toBe(400);

    // Even after the computer collected its token.
    const answer = linkPollResponseSchema.parse((await poll(g, link)).json());
    expect(answer.status).toBe('approved');
    const late = await approve(g, link.code, 'alice');
    expect(late.statusCode).toBe(200);
    expect((await approve(g, link.code, 'bob')).statusCode).toBe(400);
  });

  it('refuses approval after the code expired, and the computer hears expired', async () => {
    let clock = Date.parse('2026-10-01T09:00:00.000Z');
    const g = await gateway({ links: new LinkBook(() => clock) });
    const link = await ask(g);
    // The phone opened the confirm screen just in time...
    expect(
      (await g.send('GET', `/v1/link-requests/${link.code}`, { user: 'alice' })).statusCode,
    ).toBe(200);
    // ...and tapped Link a second too late.
    clock += LINK_TTL_MS + 1_000;
    const late = await approve(g, link.code, 'alice');
    expect(late.statusCode).toBe(410);
    expect(errorResponseSchema.parse(late.json()).error.code).toBe('pairing_invalid');
    expect((await poll(g, link)).json()).toEqual({ status: 'expired' });
    const mine = connectorListResponseSchema.parse(
      (await g.send('GET', '/v1/connectors', { user: 'alice' })).json(),
    );
    expect(mine.connectors).toEqual([]);
  });

  it('still hands over the token when the code expires while the computer is being saved', () => {
    let clock = 0;
    const book = new LinkBook(() => clock);
    const created = book.create('ip', 'Mac', CODEX);
    if (!created.ok) throw new Error('not created');
    const taken = book.beginApprove(created.request.code, 'alice')!;
    clock += LINK_TTL_MS + 1;
    book.approved(taken, `con_${'a'.repeat(20)}`, `cct_${'t'.repeat(43)}`);
    expect(book.poll(created.request.id, created.pollToken)).toMatchObject({ status: 'approved' });
  });

  it('rejects once; a second reject or a late approve finds nothing', async () => {
    const g = await gateway();
    const link = await ask(g);
    const reject = () => g.send('POST', `/v1/link-requests/${link.code}/reject`, { user: 'alice' });
    expect((await reject()).statusCode).toBe(204);
    expect((await reject()).statusCode).toBe(400);
    expect((await approve(g, link.code, 'alice')).statusCode).toBe(400);
    expect((await poll(g, link)).json()).toEqual({ status: 'rejected' });
  });
});

describe('the computer polling', () => {
  it('hands the same token to two polls with the same token, and to nobody else', async () => {
    const book = new LinkBook();
    const g = await gateway({ links: book });
    const link = await ask(g);
    const one = poll(g, link, 25);
    const two = poll(g, link, 25);
    // Both parked before the approval.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(book.waiterCount()).toBe(2);
    expect((await approve(g, link.code, 'alice')).statusCode).toBe(200);
    const answers = await Promise.all([one, two]);
    const approved = answers.map((a) => linkPollResponseSchema.parse(a.json()));
    expect(approved[0]).toMatchObject({ status: 'approved' });
    expect(approved[1]).toEqual(approved[0]);
    expect(book.waiterCount()).toBe(0);
  });

  it('frees the waiter when the computer drops its long poll, and works when it comes back', async () => {
    const book = new LinkBook();
    const g = await gateway({ links: book });
    const link = await ask(g);
    const url = `${httpBase(g)}/v1/connectors/link-requests/${link.request_id}?wait=25`;
    const headers = { authorization: `Bearer ${link.poll_token}` };
    const dropped = new AbortController();
    const first = fetch(url, { headers, signal: dropped.signal }).catch(() => 'dropped');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(book.waiterCount()).toBe(1);
    dropped.abort();
    expect(await first).toBe('dropped');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(book.waiterCount()).toBe(0);

    const second = fetch(url, { headers });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await approve(g, link.code, 'alice')).statusCode).toBe(200);
    const answer = linkPollResponseSchema.parse(await (await second).json());
    expect(answer.status).toBe('approved');
  });

  it('wakes a long poll at expiry instead of holding it the full wait', async () => {
    let offset = 0;
    const book = new LinkBook(() => Date.now() + offset);
    const created = book.create('ip', 'Mac', CODEX);
    if (!created.ok) throw new Error('not created');
    offset = LINK_TTL_MS - 100;
    const started = Date.now();
    const answer = await book.wait(
      created.request.id,
      created.pollToken,
      25_000,
      new AbortController().signal,
    );
    expect(answer).toEqual({ status: 'expired' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(book.waiterCount()).toBe(0);
  });

  it("never answers request A with request B's token", async () => {
    const g = await gateway();
    const a = await ask(g, '198.51.100.60');
    const b = await ask(g, '198.51.100.61');
    await approve(g, a.code, 'alice');
    const crossed = await poll(g, a, 0, b.poll_token);
    expect(crossed.statusCode).toBe(404);
    expect(crossed.body).not.toContain('cct_');
    // A's token is still there for A.
    expect(linkPollResponseSchema.parse((await poll(g, a)).json()).status).toBe('approved');
  });

  it('keeps tokens out of answers that are not the approval', async () => {
    const g = await gateway();
    const link = await ask(g);
    const approved = await approve(g, link.code, 'alice');
    expect(approved.body).not.toContain('cct_');
    expect(approved.body).not.toContain(link.poll_token);
    const wrong = await poll(g, link, 0, `clp_${'x'.repeat(43)}`);
    expect(wrong.body).not.toContain('clp_');
    expect(wrong.body).not.toContain('cct_');
  });
});

describe('flooding', () => {
  it('caps open requests in all, frees them as they expire, and keeps memory bounded', () => {
    let clock = 0;
    const book = new LinkBook(() => clock);
    for (let i = 0; i < MAX_OPEN_LINKS; i += 1) {
      expect(book.create(`10.0.${i >> 8}.${i & 255}`, 'Mac', CODEX).ok).toBe(true);
    }
    expect(book.create('10.9.9.9', 'Mac', CODEX)).toEqual({ ok: false, reason: 'full' });
    clock += LINK_TTL_MS;
    expect(book.create('10.9.9.9', 'Mac', CODEX).ok).toBe(true);
  });

  it('drops the oldest open request from one address, not another address', () => {
    const book = new LinkBook();
    const other = book.create('10.1.1.1', 'Mac', CODEX);
    if (!other.ok) throw new Error('not created');
    for (let i = 0; i <= MAX_OPEN_LINKS_PER_IP; i += 1) book.create('10.2.2.2', 'Mac', CODEX);
    expect(book.pendingByCode(other.request.code)).toBeDefined();
  });

  it('answers a poll for a request the server forgot (a restart) with 404, at once', async () => {
    const g = await gateway();
    const link = await ask(g);
    const fresh = await gateway();
    const started = Date.now();
    const res = await poll(fresh, link, 25);
    expect(res.statusCode).toBe(404);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('logs', () => {
  it('never logs a link code from the URL', () => {
    for (const url of [
      '/v1/link-requests/ABCD-EFGH',
      '/v1/link-requests/abcdefgh/approve',
      '/v1/link-requests/ABCD-EFGH/reject?x=1',
    ]) {
      expect(safeUrl(url)).not.toMatch(/abcd|ABCD/);
      const logged = LOG_SERIALIZERS.req({ method: 'POST', url, id: 'r1' } as never);
      expect(JSON.stringify(logged)).not.toMatch(/abcd|ABCD/);
    }
    // The route itself stays readable.
    expect(safeUrl('/v1/link-requests/ABCD-EFGH/approve')).toBe('/v1/link-requests/[code]/approve');
    expect(safeUrl('/v1/connectors/link-requests/link_abc')).toBe(
      '/v1/connectors/link-requests/link_abc',
    );
  });
});
