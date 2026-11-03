import {
  connectorListResponseSchema,
  createLinkResponseSchema,
  errorResponseSchema,
  linkApproveResponseSchema,
  linkPollResponseSchema,
  linkRequestDetailsSchema,
  type CreateLinkResponse,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { LINK_TTL_MS, LinkBook, MAX_OPEN_LINKS_PER_IP } from './link-requests';
import { startFakeConnector } from './testing';

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway(options: Parameters<typeof startConnectorGateway>[0] = {}) {
  const g = await startConnectorGateway(options);
  gateways.push(g);
  return g;
}

const AGENTS = [
  { local_agent: 'claude-code', kind: 'claude-code', label: 'Claude Code' },
  { local_agent: 'gemini', kind: 'acp', label: 'Gemini CLI' },
];

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

const codeOf = (link: CreateLinkResponse, dash = true) =>
  dash ? link.code : link.code.replace('-', '').toLowerCase();

describe('computer-first linking', () => {
  it('links a computer: details, approval, one-time token, and a working relay socket', async () => {
    const g = await gateway();
    const link = await ask(g);
    expect(link.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(linkPollResponseSchema.parse((await poll(g, link)).json())).toEqual({
      status: 'pending',
    });

    // The phone types the code in lower case without the dash.
    const details = await g.send('GET', `/v1/link-requests/${codeOf(link, false)}`, {
      user: 'alice',
    });
    expect(linkRequestDetailsSchema.parse(details.json())).toMatchObject({
      computer_name: 'Studio Mac',
      agents: AGENTS,
    });

    // A long poll parked before the approval wakes with it.
    const waiting = poll(g, link, 25);
    const approved = await g.send('POST', `/v1/link-requests/${link.code}/approve`, {
      user: 'alice',
    });
    expect(approved.statusCode).toBe(200);
    const body = linkApproveResponseSchema.parse(approved.json());
    expect(body).toMatchObject({ computer_name: 'Studio Mac', agents: AGENTS });

    const answer = linkPollResponseSchema.parse((await waiting).json());
    if (answer.status !== 'approved') throw new Error(`expected approved, got ${answer.status}`);
    expect(answer.connector_id).toBe(body.connector_id);

    // The same poll token may collect it again for a minute (a dropped delivery), no one else.
    expect(linkPollResponseSchema.parse((await poll(g, link)).json())).toEqual(answer);

    const mine = connectorListResponseSchema.parse(
      (await g.send('GET', '/v1/connectors', { user: 'alice' })).json(),
    );
    expect(mine.connectors.map((c) => c.id)).toEqual([body.connector_id]);
    expect(mine.connectors[0]?.agents.map((a) => a.id)).toEqual(['claude-code', 'gemini']);
    // The stored row holds only the hash.
    expect(JSON.stringify(await g.stores.connectors.list('alice'))).not.toContain(
      answer.connector_token,
    );

    const connector = startFakeConnector({ url: g.socketUrl, token: answer.connector_token });
    await connector.ready;
    connector.terminate();
  });

  it('isolates users: the approver owns the computer, and a used code works for no one', async () => {
    const g = await gateway();
    const link = await ask(g);
    await g.send('POST', `/v1/link-requests/${link.code}/approve`, { user: 'alice' });
    const theirs = await g.send('GET', `/v1/link-requests/${link.code}`, { user: 'bob' });
    expect(theirs.statusCode).toBe(400);
    expect(errorResponseSchema.parse(theirs.json()).error.code).toBe('pairing_invalid');
    // Plain words: the person never typed a command, so the message names none.
    expect(errorResponseSchema.parse(theirs.json()).error.message).toBe(
      'That code is wrong, used, or expired. Get a new code on your computer and try again.',
    );
    const again = await g.send('POST', `/v1/link-requests/${link.code}/approve`, { user: 'bob' });
    expect(again.statusCode).toBe(400);
    const bobs = connectorListResponseSchema.parse(
      (await g.send('GET', '/v1/connectors', { user: 'bob' })).json(),
    );
    expect(bobs.connectors).toEqual([]);
  });

  it('needs a signed-in user on the phone routes', async () => {
    const g = await gateway();
    const link = await ask(g);
    expect((await g.send('GET', `/v1/link-requests/${link.code}`)).statusCode).toBe(401);
    expect((await g.send('POST', `/v1/link-requests/${link.code}/approve`)).statusCode).toBe(401);
  });

  it('tells the computer when the phone cancels', async () => {
    const g = await gateway();
    const link = await ask(g);
    const waiting = poll(g, link, 25);
    const rejected = await g.send('POST', `/v1/link-requests/${link.code}/reject`, {
      user: 'alice',
    });
    expect(rejected.statusCode).toBe(204);
    expect((await waiting).json()).toEqual({ status: 'rejected' });
    expect((await poll(g, link)).json()).toEqual({ status: 'rejected' });
    const late = await g.send('POST', `/v1/link-requests/${link.code}/approve`, { user: 'alice' });
    expect(late.statusCode).toBe(400);
  });

  it('expires after 10 minutes for both sides', async () => {
    let clock = Date.parse('2026-10-01T09:00:00.000Z');
    const g = await gateway({ links: new LinkBook(() => clock) });
    const link = await ask(g);
    clock += LINK_TTL_MS;
    expect((await poll(g, link)).json()).toEqual({ status: 'expired' });
    const phone = await g.send('GET', `/v1/link-requests/${link.code}`, { user: 'alice' });
    expect(phone.statusCode).toBe(410);
    expect(errorResponseSchema.parse(phone.json()).error.message).toBe(
      'That code expired. Get a new code on your computer and try again.',
    );
    const approve = await g.send('POST', `/v1/link-requests/${link.code}/approve`, {
      user: 'alice',
    });
    expect(approve.statusCode).toBe(410);
  });

  it('refuses a wrong, missing, or malformed poll token', async () => {
    const g = await gateway();
    const link = await ask(g);
    const other = await ask(g);
    expect((await poll(g, link, 0, other.poll_token)).statusCode).toBe(404);
    const bare = await g.send('GET', `/v1/connectors/link-requests/${link.request_id}`);
    expect(bare.statusCode).toBe(401);
    expect((await poll(g, link, 0, 'clp_short')).statusCode).toBe(401);
    const unknown = await g.send('GET', `/v1/connectors/link-requests/link_${'a'.repeat(20)}`, {
      headers: { authorization: `Bearer ${link.poll_token}` },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('validates the computer details', async () => {
    const g = await gateway();
    for (const body of [
      {},
      { computer_name: 'x'.repeat(41), agents: AGENTS },
      { computer_name: 'Mac', agents: [] },
      { computer_name: 'Mac', agents: AGENTS, extra: true },
    ]) {
      const res = await g.send('POST', '/v1/connectors/link-requests', { body });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rate limits link requests per address', async () => {
    const g = await gateway({ linkCreatePerHour: 2 });
    await ask(g, '198.51.100.1');
    await ask(g, '198.51.100.1');
    const third = await g.send('POST', '/v1/connectors/link-requests', {
      body: { computer_name: 'Mac', agents: AGENTS },
      ip: '198.51.100.1',
    });
    expect(third.statusCode).toBe(429);
    await ask(g, '198.51.100.2');
  });

  it('keeps only a few open requests per address, dropping the oldest', async () => {
    const g = await gateway();
    const first = await ask(g, '198.51.100.3');
    for (let i = 0; i < MAX_OPEN_LINKS_PER_IP; i += 1) await ask(g, '198.51.100.3');
    expect((await poll(g, first)).statusCode).toBe(404);
  });

  it('makes a user wait after too many wrong codes, even for a right one', async () => {
    const g = await gateway({ linkGuessesPerHour: 3 });
    const link = await ask(g);
    for (let i = 0; i < 3; i += 1) {
      const wrong = await g.send('GET', '/v1/link-requests/AAAA-AAAA', { user: 'mallory' });
      expect(wrong.statusCode).toBe(400);
    }
    const blocked = await g.send('GET', `/v1/link-requests/${link.code}`, { user: 'mallory' });
    expect(blocked.statusCode).toBe(429);
    // Other users are unaffected.
    const fine = await g.send('GET', `/v1/link-requests/${link.code}`, { user: 'alice' });
    expect(fine.statusCode).toBe(200);
  });
});

describe('LinkBook', () => {
  it('releases a long-poll waiter when the computer goes away', async () => {
    const book = new LinkBook();
    const created = book.create('ip', 'Mac', [
      { local_agent: 'codex', kind: 'codex', label: 'Codex' },
    ]);
    if (!created.ok) throw new Error('not created');
    const gone = new AbortController();
    const waiting = book.wait(created.request.id, created.pollToken, 25_000, gone.signal);
    expect(book.waiterCount()).toBe(1);
    gone.abort();
    expect(await waiting).toEqual({ status: 'pending' });
    expect(book.waiterCount()).toBe(0);
  });

  it('lets the code work again when saving the computer failed', () => {
    const book = new LinkBook();
    const created = book.create('ip', 'Mac', [
      { local_agent: 'codex', kind: 'codex', label: 'Codex' },
    ]);
    if (!created.ok) throw new Error('not created');
    const taken = book.beginApprove(created.request.code, 'alice');
    expect(taken).toBeDefined();
    expect(book.beginApprove(created.request.code, 'bob')).toBeUndefined();
    book.abortApprove(taken!);
    expect(book.pendingByCode(created.request.code)).toBeDefined();
  });
});
