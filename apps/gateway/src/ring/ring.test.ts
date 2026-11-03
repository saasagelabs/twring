import {
  answeredTurnText,
  callHistoryResponseSchema,
  createCallResponseSchema,
  deleteMyDataResponseSchema,
  errorResponseSchema,
  inviteListResponseSchema,
  inviteSchema,
  ringResponseSchema,
  ringStatusResponseSchema,
  type RingPush,
  userRef,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { flushMicrotasks, ManualScheduler, recordingLogger } from '../calls/testing';
import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';
import { MemoryCollection } from '../store/collection';
import { newAgentId } from '../calls/ids';
import { OPENING_LEAD_IN_MS } from '../calls/runtime';

import { RingService } from './service';
import { InviteRepository, type InviteRecord, type RingStores } from './store';

/** The agent rings its owner (ADR-024). */

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway(options: Parameters<typeof startConnectorGateway>[0] = {}) {
  const g = await startConnectorGateway({ ring: { push: false }, ...options });
  gateways.push(g);
  return g;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A paired computer with a saved agent for `user`. */
async function setupAgent(g: ConnectorGateway, user = 'alice', connect = false) {
  const paired = connect
    ? await g.connect(user)
    : { ...(await g.pair(user)), connector: undefined };
  const agentId = await g.createAgent(user, paired.connectorId);
  return { ...paired, agentId };
}

function ring(
  g: ConnectorGateway,
  token: string,
  body: Record<string, unknown> = { local_agent: 'claude-code', reason: 'The build failed' },
) {
  return g.send('POST', '/v1/connectors/ring', { headers: bearer(token), body });
}

async function ringOk(g: ConnectorGateway, token: string, body?: Record<string, unknown>) {
  const res = await ring(g, token, body);
  expect(res.statusCode).toBe(201);
  return ringResponseSchema.parse(res.json());
}

const code = (res: { json(): unknown }) => errorResponseSchema.parse(res.json()).error.code;

async function device(g: ConnectorGateway, user: string, id: string, token: string) {
  const res = await g.send('PUT', `/v1/me/devices/${id}`, {
    user,
    body: { fcm_token: token, platform: 'android', app_variant: 'beta' },
  });
  expect(res.statusCode).toBe(204);
}

async function iosDevice(g: ConnectorGateway) {
  const res = await g.send('PUT', '/v1/me/devices/iphone-0001', {
    user: 'alice',
    body: { fcm_token: 'fcm-token-iphoneaaaaaaaaaa', platform: 'ios', app_variant: 'beta' },
  });
  expect(res.statusCode).toBe(204);
}

describe('ringing', () => {
  it('accepts connector messages once and keeps older settings writes compatible', async () => {
    const g = await gateway({ threads: {} });
    const { token, agentId } = await setupAgent(g);
    const headers = { ...bearer(token), 'idempotency-key': 'work-1' };
    const body = { local_agent: 'claude-code', text: 'Complete result', origin: 'agent' };
    const first = await g.send('POST', '/v1/connectors/messages', { headers, body });
    expect(first.statusCode).toBe(201);
    const retry = await g.send('POST', '/v1/connectors/messages', { headers, body });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ ...first.json(), delivery: 'none' });
    const page = await g.threads!.store.listMessages('alice', agentId, { limit: 50 });
    expect(page.messages.filter((message) => message.kind === 'agent_text')).toHaveLength(1);
    const set = await g.send('PUT', '/v1/me/ring-settings', {
      user: 'alice',
      body: {
        dnd: false,
        quiet_hours: null,
        after_call_result: 'message',
      },
    });
    expect(set.statusCode).toBe(200);
    const oldApp = await g.send('PUT', '/v1/me/ring-settings', {
      user: 'alice',
      body: {
        dnd: true,
        quiet_hours: null,
      },
    });
    expect(oldApp.json()).toMatchObject({ after_call_result: 'message' });
  });

  it('saves a call reply without its hang-up marker, and refuses a marker alone', async () => {
    const g = await gateway({ threads: {} });
    const { token, agentId } = await setupAgent(g);
    const send = (key: string, text: string) =>
      g.send('POST', '/v1/connectors/messages', {
        headers: { ...bearer(token), 'idempotency-key': key },
        body: { local_agent: 'claude-code', text, origin: 'agent' },
      });
    expect((await send('m-1', 'All done. Bye! ⟪hangup⟫')).statusCode).toBe(201);
    expect((await send('m-2', ' [[HANGUP]] ')).statusCode).toBe(400);
    const page = await g.threads!.store.listMessages('alice', agentId, { limit: 50 });
    expect(page.messages.filter((m) => m.kind === 'agent_text')).toMatchObject([
      { text: 'All done. Bye!' },
    ]);
  });

  it('guards connector messages by feature, token, saved agent, and rate', async () => {
    const off = await gateway();
    const saved = await setupAgent(off);
    const headers = { ...bearer(saved.token), 'idempotency-key': 'work-2' };
    const body = { local_agent: 'claude-code', text: 'Done', origin: 'agent' };
    expect((await off.send('POST', '/v1/connectors/messages', { headers, body })).statusCode).toBe(
      404,
    );
    const g = await gateway({ threads: {} });
    const alice = await setupAgent(g);
    const bob = await g.pair('bob');
    expect((await g.send('POST', '/v1/connectors/messages', { body })).statusCode).toBe(401);
    expect(
      (
        await g.send('POST', '/v1/connectors/messages', {
          headers: { ...bearer(bob.token), 'idempotency-key': 'other' },
          body,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await g.send('POST', '/v1/connectors/messages', {
          headers: { ...bearer(alice.token), 'idempotency-key': 'missing' },
          body: { ...body, local_agent: 'unknown' },
        })
      ).statusCode,
    ).toBe(404);
    for (let i = 0; i < 29; i++)
      await g.send('POST', '/v1/connectors/messages', {
        headers: { ...bearer(alice.token), 'idempotency-key': `rate-${i}` },
        body,
      });
    expect(
      (
        await g.send('POST', '/v1/connectors/messages', {
          headers: { ...bearer(alice.token), 'idempotency-key': 'over' },
          body,
        })
      ).statusCode,
    ).toBe(429);
  });
  it('rings: 201 with a 30 s invite, pushes cord.ring to every phone, the phone sees it', async () => {
    const g = await gateway({ ring: {} });
    const { token, agentId } = await setupAgent(g);
    await device(g, 'alice', 'phone-0001', 'fcm-token-aaaaaaaaaaaaaaaa');
    await device(g, 'alice', 'phone-0002', 'fcm-token-bbbbbbbbbbbbbbbb');
    const created = await ringOk(g, token, {
      local_agent: 'claude-code',
      reason: 'Tests pass ‮; can I push?',
      session_ref: 'sess-1',
    });
    expect(Date.parse(created.expires_at) - g.ring!.clock.ms).toBe(30_000);
    await g.ring!.service.idle();
    const pushes = g.ring!.pushes;
    expect(pushes.map((p) => p.token).sort()).toEqual([
      'fcm-token-aaaaaaaaaaaaaaaa',
      'fcm-token-bbbbbbbbbbbbbbbb',
    ]);
    const data = pushes[0]!.data as RingPush;
    expect(Object.keys(data).sort()).toEqual(
      [
        'agent_id',
        'agent_name',
        'expires_at',
        'invite_id',
        'reason',
        'server_time',
        'type',
        'user_ref',
      ].sort(),
    );
    expect(Object.values(data).every((v) => typeof v === 'string')).toBe(true);
    expect(data).toMatchObject({
      type: 'cord.ring',
      user_ref: userRef('alice'),
      invite_id: created.invite_id,
      agent_id: agentId,
      agent_name: 'Laptop Claude',
      reason: 'Tests pass ; can I push?',
    });

    const invite = inviteSchema.parse(
      (await g.send('GET', `/v1/invites/${created.invite_id}`, { user: 'alice' })).json(),
    );
    expect(invite).toMatchObject({ status: 'pending', agent_id: agentId });
    const list = inviteListResponseSchema.parse(
      (await g.send('GET', '/v1/invites?status=pending', { user: 'alice' })).json(),
    );
    expect(list.invites.map((i) => i.invite_id)).toEqual([created.invite_id]);
    // Owner-scoped: another user sees nothing.
    expect(
      (await g.send('GET', `/v1/invites/${created.invite_id}`, { user: 'bob' })).statusCode,
    ).toBe(404);
  });

  it('needs the connector token (401), and bad bodies are 400', async () => {
    const g = await gateway();
    const { token } = await setupAgent(g);
    const none = await g.send('POST', '/v1/connectors/ring', {
      body: { local_agent: 'claude-code', reason: 'x' },
    });
    expect(none.statusCode).toBe(401);
    expect((await ring(g, `cct_${'z'.repeat(43)}`)).statusCode).toBe(401);
    expect((await ring(g, token, { local_agent: 'claude-code', reason: '' })).statusCode).toBe(400);
    expect(
      (await ring(g, token, { local_agent: 'claude-code', reason: 'x'.repeat(141) })).statusCode,
    ).toBe(400);
    expect(
      (await ring(g, token, { local_agent: 'claude-code', reason: 'x', session_ref: 'a b' }))
        .statusCode,
    ).toBe(400);
  });

  it('agent_not_saved (404): unsaved local agent, and never another user’s agent', async () => {
    const g = await gateway();
    const alice = await setupAgent(g, 'alice');
    const res = await ring(g, alice.token, { local_agent: 'gemini', reason: 'hi' });
    expect(res.statusCode).toBe(404);
    expect(code(res)).toBe('agent_not_saved');
    // Bob's computer, no agent saved by bob: alice's saved agents are out of reach.
    const bob = await g.pair('bob');
    const cross = await ring(g, bob.token);
    expect(code(cross)).toBe('agent_not_saved');
    // Bob's connector cannot read or cancel alice's invite.
    const created = await ringOk(g, alice.token);
    const peek = await g.send('GET', `/v1/connectors/ring/${created.invite_id}`, {
      headers: bearer(bob.token),
    });
    expect(peek.statusCode).toBe(404);
    const cancel = await g.send('DELETE', `/v1/connectors/ring/${created.invite_id}`, {
      headers: bearer(bob.token),
    });
    expect(cancel.statusCode).toBe(404);
  });

  it('owner_unavailable (409) for DND and for quiet hours', async () => {
    const g = await gateway();
    const { token } = await setupAgent(g);
    const defaults = await g.send('GET', '/v1/me/ring-settings', { user: 'alice' });
    expect(defaults.json()).toEqual({ dnd: false, quiet_hours: null, after_call_result: 'ring' });

    await g.send('PUT', '/v1/me/ring-settings', {
      user: 'alice',
      body: { dnd: true, quiet_hours: null },
    });
    const dnd = await ring(g, token);
    expect(dnd.statusCode).toBe(409);
    expect(code(dnd)).toBe('owner_unavailable');

    // 09:00 UTC is 14:30 in Kolkata: inside 14:00–15:00.
    const put = await g.send('PUT', '/v1/me/ring-settings', {
      user: 'alice',
      body: {
        dnd: false,
        quiet_hours: { enabled: true, start: '14:00', end: '15:00', tz: 'Asia/Kolkata' },
      },
    });
    expect(put.statusCode).toBe(200);
    expect(code(await ring(g, token))).toBe('owner_unavailable');
    await g.send('PUT', '/v1/me/ring-settings', {
      user: 'alice',
      body: {
        dnd: false,
        quiet_hours: { enabled: true, start: '22:00', end: '07:00', tz: 'Asia/Kolkata' },
      },
    });
    expect((await ring(g, token)).statusCode).toBe(201);
    const bad = await g.send('PUT', '/v1/me/ring-settings', {
      user: 'alice',
      body: { dnd: false, quiet_hours: { enabled: true, start: '25:00', end: '07:00', tz: 'X/Y' } },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('owner_busy (409) while the owner is in a call', async () => {
    const g = await gateway({ calls: { allowance: { callSeconds: 0, calls: 5 } } });
    const { token, agentId } = await setupAgent(g, 'alice', true);
    const call = await g.send('POST', '/v1/calls', { user: 'alice', body: { agent_id: agentId } });
    expect(call.statusCode).toBe(201);
    const res = await ring(g, token);
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('owner_busy');
  });

  it('refuses a ring with push when no Android phone is registered', async () => {
    const g = await gateway({ ring: { requireRingPhone: true } });
    const { token } = await setupAgent(g);
    const noDevice = await ring(g, token);
    expect(noDevice.statusCode).toBe(409);
    expect(noDevice.json()).toMatchObject({
      error: {
        code: 'no_ring_phone',
        message: "Your phone can't ring yet: open Twring on your phone and sign in.",
      },
    });
    expect(await g.ring!.stores.invites.list('alice')).toEqual([]);
    await iosDevice(g);
    expect(code(await ring(g, token))).toBe('no_ring_phone');
    await device(g, 'alice', 'phone-0001', 'fcm-token-aaaaaaaaaaaaaaaa');
    expect((await ring(g, token)).statusCode).toBe(201);
  });

  it('rings an iPhone once APNs is configured, and sends its alert token along', async () => {
    const g = await gateway({
      ring: { requireRingPhone: true, ringPlatforms: ['android', 'ios'] },
    });
    const { token } = await setupAgent(g);
    const registered = await g.send('PUT', '/v1/me/devices/iphone-0001', {
      user: 'alice',
      body: {
        fcm_token: 'a'.repeat(64),
        platform: 'ios',
        app_variant: 'production',
        apns_token: 'b'.repeat(64),
      },
    });
    expect(registered.statusCode).toBe(204);
    expect((await ring(g, token)).statusCode).toBe(201);
    expect(await g.ring!.stores.devices.list('alice')).toMatchObject([
      { platform: 'ios', apns_token: 'b'.repeat(64) },
    ]);
  });

  it('refuses a malformed iOS alert token', async () => {
    const g = await gateway({ ring: {} });
    const res = await g.send('PUT', '/v1/me/devices/iphone-0001', {
      user: 'alice',
      body: {
        fcm_token: 'a'.repeat(64),
        platform: 'ios',
        app_variant: 'production',
        apns_token: 'not-hex',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps polling-mode rings without push or a registered phone', async () => {
    const g = await gateway();
    const { token } = await setupAgent(g);
    expect((await ring(g, token)).statusCode).toBe(201);
  });

  it('ring_pending (409) while one rings; ring_rate_limited (409) after 6 per agent per hour', async () => {
    const g = await gateway();
    const { token } = await setupAgent(g);
    const first = await ringOk(g, token);
    const again = await ring(g, token);
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('ring_pending');
    await g.send('DELETE', `/v1/connectors/ring/${first.invite_id}`, { headers: bearer(token) });
    for (let i = 0; i < 5; i += 1) {
      const next = await ringOk(g, token);
      await g.send('DELETE', `/v1/connectors/ring/${next.invite_id}`, { headers: bearer(token) });
    }
    const limited = await ring(g, token);
    expect(limited.statusCode).toBe(409);
    expect(code(limited)).toBe('ring_rate_limited');
    g.ring!.clock.ms += 61 * 60_000;
    expect((await ring(g, token)).statusCode).toBe(201);
  });
});

describe('outcomes', () => {
  it('long-poll: pending after the wait, then declined with the note', async () => {
    const g = await gateway();
    const { token } = await setupAgent(g);
    const { invite_id: id } = await ringOk(g, token);
    const url = `/v1/connectors/ring/${id}?wait=25`;

    const timedOut = g.send('GET', url, { headers: bearer(token) });
    await waitFor(() => g.ring!.scheduler.pending >= 2);
    g.ring!.scheduler.advance(25_000);
    expect(ringStatusResponseSchema.parse((await timedOut).json())).toEqual({ status: 'pending' });

    const waiting = g.send('GET', url, { headers: bearer(token) });
    await waitFor(() => g.ring!.scheduler.pending >= 2);
    const declined = await g.send('POST', `/v1/invites/${id}/decline`, {
      user: 'alice',
      body: { note: 'busy' },
    });
    expect(declined.statusCode).toBe(200);
    expect((await waiting).json()).toEqual({ status: 'declined', note: 'busy' });
    await g.ring!.service.idle();
    expect(g.ring!.pushes).toEqual([]); // No phones registered.

    const twice = await g.send('POST', `/v1/invites/${id}/decline`, { user: 'alice', body: {} });
    expect(code(twice)).toBe('invite_already_handled');
  });

  it('decline notes: free text up to 60 characters, sanitized', async () => {
    const g = await gateway();
    const { token } = await setupAgent(g);
    const { invite_id: id } = await ringOk(g, token);
    const long = await g.send('POST', `/v1/invites/${id}/decline`, {
      user: 'alice',
      body: { note: 'x'.repeat(61) },
    });
    expect(long.statusCode).toBe(400);
    await g.send('POST', `/v1/invites/${id}/decline`, {
      user: 'alice',
      body: { note: 'call me\u0007 at 5' },
    });
    const status = await g.send('GET', `/v1/connectors/ring/${id}`, { headers: bearer(token) });
    expect(status.json()).toEqual({ status: 'declined', note: 'call me at 5' });
  });

  it('cancel: the agent changed its mind; the phone gets cord.ring_cancel', async () => {
    const g = await gateway({ ring: {} });
    const { token } = await setupAgent(g);
    await device(g, 'alice', 'phone-0001', 'fcm-token-aaaaaaaaaaaaaaaa');
    const { invite_id: id } = await ringOk(g, token);
    const res = await g.send('DELETE', `/v1/connectors/ring/${id}`, { headers: bearer(token) });
    expect(res.json()).toEqual({ status: 'cancelled' });
    await g.ring!.service.idle();
    expect(g.ring!.pushes.at(-1)!.data).toEqual({
      type: 'cord.ring_cancel',
      user_ref: userRef('alice'),
      invite_id: id,
      status: 'cancelled',
      agent_name: 'Laptop Claude',
    });
    const answer = await g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' });
    expect(answer.statusCode).toBe(503); // No calling in this gateway; see the calls tests below.
  });

  it('expiry: missed after 30 s, voicemail in call history, ring_cancel, long-poll says missed', async () => {
    const g = await gateway({ ring: {} });
    const { token, agentId } = await setupAgent(g);
    await device(g, 'alice', 'phone-0001', 'fcm-token-aaaaaaaaaaaaaaaa');
    const { invite_id: id } = await ringOk(g, token);
    g.ring!.scheduler.advance(10_000);
    const waiting = g.send('GET', `/v1/connectors/ring/${id}?wait=25`, { headers: bearer(token) });
    await waitFor(() => g.ring!.scheduler.pending >= 2);
    g.ring!.clock.ms += RING_TTL;
    g.ring!.scheduler.advance(RING_TTL - 10_000);
    expect((await waiting).json()).toEqual({ status: 'missed' });
    await g.ring!.service.idle();
    expect(g.ring!.pushes.at(-1)!.data).toMatchObject({
      type: 'cord.ring_cancel',
      status: 'missed',
    });
    const history = callHistoryResponseSchema.parse(
      (await g.send('GET', '/v1/calls/history', { user: 'alice' })).json(),
    );
    expect(history.calls[0]).toMatchObject({
      call_id: id,
      kind: 'missed_invite',
      agent_id: agentId,
      reason: 'The build failed',
      outcome: 'missed',
      duration_s: 0,
    });
    const late = await g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' });
    expect(late.statusCode).toBe(503);
  });

  it('push: an UNREGISTERED token deletes that device; others stay', async () => {
    const g = await gateway({
      ring: { push: (t) => (t.startsWith('fcm-dead') ? 'invalid' : 'sent') },
    });
    const { token } = await setupAgent(g);
    await device(g, 'alice', 'phone-0001', 'fcm-dead-aaaaaaaaaaaaaaaa');
    await device(g, 'alice', 'phone-0002', 'fcm-live-aaaaaaaaaaaaaaaa');
    await ringOk(g, token);
    await g.ring!.service.idle();
    expect((await g.ring!.stores.devices.list('alice')).map((d) => d.device_id)).toEqual([
      'phone-0002',
    ]);
  });

  it('push reached no phone: the ring settles at once so the agent can send a message (review finding 2)', async () => {
    const g = await gateway({
      ring: { push: (t) => (t.startsWith('fcm-dead') ? 'invalid' : 'failed') },
    });
    const { token } = await setupAgent(g);
    await device(g, 'alice', 'phone-0001', 'fcm-dead-aaaaaaaaaaaaaaaa');
    await device(g, 'alice', 'phone-0002', 'fcm-flaky-aaaaaaaaaaaaaaa');
    const { invite_id: id } = await ringOk(g, token);
    await g.ring!.service.idle();
    // What the agent sees: declined, with what to do instead.
    const status = await g.send('GET', `/v1/connectors/ring/${id}`, { headers: bearer(token) });
    expect(status.json()).toEqual({
      status: 'declined',
      note: 'Phone unreachable; send a message instead',
    });
  });

  it('a phone whose push service is not set up (skipped) keeps ringing: the app may still poll', async () => {
    const g = await gateway({ ring: { push: () => 'skipped' } });
    const { token } = await setupAgent(g);
    await device(g, 'alice', 'phone-0001', 'fcm-ios-only-aaaaaaaaaaa');
    const { invite_id: id } = await ringOk(g, token);
    await g.ring!.service.idle();
    const status = await g.send('GET', `/v1/connectors/ring/${id}`, { headers: bearer(token) });
    expect(status.json()).toEqual({ status: 'pending' });
  });

  it('push reached at least one phone: the ring keeps ringing', async () => {
    const g = await gateway({
      ring: { push: (t) => (t.startsWith('fcm-dead') ? 'invalid' : 'sent') },
    });
    const { token } = await setupAgent(g);
    await device(g, 'alice', 'phone-0001', 'fcm-dead-aaaaaaaaaaaaaaaa');
    await device(g, 'alice', 'phone-0002', 'fcm-live-aaaaaaaaaaaaaaaa');
    const { invite_id: id } = await ringOk(g, token);
    await g.ring!.service.idle();
    const status = await g.send('GET', `/v1/connectors/ring/${id}`, { headers: bearer(token) });
    expect(status.json()).toEqual({ status: 'pending' });
  });

  it('push unconfigured: rings still create invites the phone can see', async () => {
    const g = await gateway({ ring: { push: false } });
    const { token } = await setupAgent(g);
    await device(g, 'alice', 'phone-0001', 'fcm-token-aaaaaaaaaaaaaaaa');
    const { invite_id: id } = await ringOk(g, token);
    await g.ring!.service.idle();
    expect(g.ring!.pushes).toEqual([]);
    expect((await g.send('GET', `/v1/invites/${id}`, { user: 'alice' })).statusCode).toBe(200);
  });
});

const RING_TTL = 30_000;

describe('answering', () => {
  it('lists, blocks, allows, and erases connected AI apps', async () => {
    const g = await gateway({ threads: {} });
    const publicCreate = await g.send('POST', '/v1/agents', {
      user: 'alice',
      body: { name: 'Claude', protocol: 'mcp-app', endpoint_url: 'mcp-app://claude' },
    });
    expect(publicCreate.statusCode).toBe(400);
    const id = newAgentId();
    const at = new Date().toISOString();
    await g.stores.agents.create({
      id,
      user_id: 'alice',
      name: 'Claude',
      protocol: 'mcp-app',
      endpoint_url: 'mcp-app://claude',
      voice_id: 'flux-haley-en',
      status: 'ready',
      created_at: at,
      updated_at: at,
    });
    const listed = await g.send('GET', '/v1/me/connected-apps', { user: 'alice' });
    expect(listed.json()).toMatchObject({
      apps: [{ agent_id: id, client_id: 'claude', name: 'Claude', blocked: false }],
    });
    await g.threads!.service.deliverResult('alice', id, {
      text: 'Hello',
      origin: 'agent',
      idempotencyKey: 'mcp:claude:1',
      target: { agentName: 'Claude' },
    });
    expect(
      (await g.send('POST', '/v1/me/connected-apps/claude/block', { user: 'alice' })).statusCode,
    ).toBe(204);
    expect(await g.stores.agents.get('alice', id)).toBeUndefined();
    expect((await g.threads!.store.listMessages('alice', id, { limit: 20 })).messages).toHaveLength(
      0,
    );
    expect((await g.send('GET', '/v1/me/connected-apps', { user: 'alice' })).json()).toMatchObject({
      apps: [{ client_id: 'claude', blocked: true }],
    });
    expect(
      (await g.send('POST', '/v1/me/connected-apps/claude/allow', { user: 'alice' })).statusCode,
    ).toBe(204);
    expect((await g.send('GET', '/v1/me/connected-apps', { user: 'alice' })).json()).toEqual({
      apps: [],
    });
    await g.stores.agents.create({
      id: newAgentId(),
      user_id: 'alice',
      name: 'Claude',
      protocol: 'mcp-app',
      endpoint_url: 'mcp-app://claude',
      voice_id: 'flux-haley-en',
      status: 'ready',
      created_at: at,
      updated_at: at,
    });
    const second = (await g.stores.agents.list('alice'))[0]!;
    expect((await g.send('DELETE', `/v1/agents/${second.id}`, { user: 'alice' })).statusCode).toBe(
      204,
    );
    expect((await g.send('GET', '/v1/me/connected-apps', { user: 'alice' })).json()).toMatchObject({
      apps: [{ client_id: 'claude', blocked: true }],
    });
    expect((await g.send('DELETE', '/v1/me/data', { user: 'alice' })).statusCode).toBe(200);
    expect((await g.send('GET', '/v1/me/connected-apps', { user: 'alice' })).json()).toEqual({
      apps: [],
    });
  });
  it('answers an AI app ring in chat without a call or agent turn', async () => {
    const g = await gateway({ calls: {}, threads: {}, ring: {} });
    const id = newAgentId();
    const at = new Date().toISOString();
    await g.stores.agents.create({
      id,
      user_id: 'alice',
      name: 'Claude',
      protocol: 'mcp-app',
      endpoint_url: 'mcp-app://claude',
      voice_id: 'flux-haley-en',
      status: 'ready',
      created_at: at,
      updated_at: at,
    });
    const call = await g.send('POST', '/v1/calls', { user: 'alice', body: { agent_id: id } });
    expect(call.statusCode).toBe(400);
    expect(code(call)).toBe('not_supported');
    const test = await g.send('POST', `/v1/agents/${id}/test`, { user: 'alice' });
    expect(test.statusCode).toBe(400);
    expect(code(test)).toBe('not_supported');
    const placed = await g.ring!.service.ring({
      userId: 'alice',
      agentId: id,
      agentName: 'Claude',
      reason: 'The build failed',
    });
    expect('invite' in placed).toBe(true);
    if (!('invite' in placed)) return;
    const answer = await g.send('POST', `/v1/invites/${placed.invite.id}/answer`, {
      user: 'alice',
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ mode: 'chat', agent_id: id });
    expect(g.calls!.registry.hasLiveCall('alice')).toBe(false);
    const page = await g.threads!.store.listMessages('alice', id, { limit: 20 });
    expect(page.messages.filter((m) => m.kind === 'agent_text')).toMatchObject([
      { text: 'The build failed' },
    ]);
    const owner = await g.threads!.service.send('alice', id, {
      clientId: 'bdc022a0-d9d0-4de9-8f70-9450a59e2d90',
      text: 'I saw it',
    });
    expect(owner.message).toMatchObject({ kind: 'user_text', status: 'sent' });
    await g.threads!.service.sweep();
    expect(await g.threads!.store.findMessageById('alice', id, owner.message.id)).toMatchObject({
      status: 'sent',
    });
    await device(g, 'alice', 'phone-0001', 'fcm-token-aaaaaaaaaaaaaaaa');
    await g.threads!.service.deliverResult('alice', id, {
      text: 'A new update',
      origin: 'agent',
      idempotencyKey: 'mcp:claude:1',
      target: { agentName: 'Claude' },
    });
    await waitFor(() => g.ring!.pushes.some((push) => push.data.type === 'cord.message'));
    expect(
      (await g.threads!.store.listMessages('alice', id, { limit: 20 })).messages.filter(
        (m) => m.kind === 'agent_text',
      ),
    ).toHaveLength(2);
  });
  async function callingGateway() {
    const g = await gateway({ calls: { allowance: { callSeconds: 0, calls: 5 } } });
    const setup = await setupAgent(g, 'alice', true);
    return { g, ...setup };
  }

  it('answer starts the call; the agent speaks first and resumes the session', async () => {
    const { g, token, connector } = await callingGateway();
    const { invite_id: id } = await ringOk(g, token, {
      local_agent: 'claude-code',
      reason: 'The build failed',
      session_ref: 'sess-42',
    });
    const res = await g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' });
    expect(res.statusCode).toBe(201);
    createCallResponseSchema.parse(res.json());
    const status = await g.send('GET', `/v1/connectors/ring/${id}`, { headers: bearer(token) });
    expect(status.json()).toEqual({ status: 'answered' });

    const transport = g.calls!.transports[0]!;
    await waitFor(() => transport.states.includes('ready'));
    transport.emit({ type: 'caller_joined' });
    await flushMicrotasks();
    // The opening waits for the caller's audio to flow, so its first words are heard.
    expect(connector!.received.some((r) => r.message.type === 'user.turn')).toBe(false);
    transport.frame(new Int16Array(480));
    // Then a beat more while the phone's speaker comes up (build 9: first words rushed).
    await flushMicrotasks();
    expect(OPENING_LEAD_IN_MS).toBe(1_000);
    g.calls!.scheduler.advance(OPENING_LEAD_IN_MS - 1);
    await flushMicrotasks();
    expect(connector!.received.some((r) => r.message.type === 'user.turn')).toBe(false);
    g.calls!.scheduler.advance(1);
    await waitFor(() => connector!.received.some((r) => r.message.type === 'user.turn'));
    expect(connector!.opened[0]).toMatchObject({ agent: 'claude-code', resume_ref: 'sess-42' });
    const turn = connector!.received.find((r) => r.message.type === 'user.turn')!.message;
    expect(turn).toMatchObject({ text: answeredTurnText('The build failed', { spoken: true }) });
    await flushMicrotasks();
  });

  it('a quick "Hello?" during the lead-in does not lose the opening (review)', async () => {
    const { g, token, connector } = await callingGateway();
    const { invite_id: id } = await ringOk(g, token, {
      local_agent: 'claude-code',
      reason: 'The build failed',
    });
    expect((await g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' })).statusCode).toBe(
      201,
    );
    const transport = g.calls!.transports[0]!;
    await waitFor(() => transport.states.includes('ready'));
    transport.emit({ type: 'caller_joined' });
    transport.frame(new Int16Array(480));
    await flushMicrotasks();
    // They start speaking before the lead-in ends: the opening goes now, before their turn.
    g.calls!.stt.send({ type: 'speech_started', turnIndex: 0 });
    await waitFor(() => connector!.received.some((r) => r.message.type === 'user.turn'));
    const turn = connector!.received.find((r) => r.message.type === 'user.turn')!.message;
    expect(turn).toMatchObject({ text: answeredTurnText('The build failed', { spoken: true }) });
  });

  it('an empty stored reason keeps the old opening prompt', async () => {
    const rows = new MemoryCollection<InviteRecord>();
    const g = await gateway({
      calls: { allowance: { callSeconds: 0, calls: 5 } },
      ring: { invites: rows },
    });
    const { token, connector } = await setupAgent(g, 'alice', true);
    const { invite_id: id } = await ringOk(g, token);
    await rows.update((invites) => ({
      items: invites.map((invite) => (invite.id === id ? { ...invite, reason: '   ' } : invite)),
      result: undefined,
    }));
    const res = await g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' });
    expect(res.statusCode).toBe(201);
    const transport = g.calls!.transports[0]!;
    await waitFor(() => transport.states.includes('ready'));
    transport.emit({ type: 'caller_joined' });
    transport.frame(new Int16Array(480));
    await flushMicrotasks();
    g.calls!.scheduler.advance(OPENING_LEAD_IN_MS);
    await waitFor(() => connector!.received.some((r) => r.message.type === 'user.turn'));
    const turn = connector!.received.find((r) => r.message.type === 'user.turn')!.message;
    expect(turn).toMatchObject({ text: answeredTurnText('   ') });
  });

  it('two answers at once: one call, the other invite_already_handled', async () => {
    const { g, token } = await callingGateway();
    const { invite_id: id } = await ringOk(g, token);
    const [a, b] = await Promise.all([
      g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' }),
      g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(code(a.statusCode === 409 ? a : b)).toBe('invite_already_handled');
    expect(g.calls!.registry.activeCount).toBe(1);
  });

  it('answer after expiry is invite_expired (410)', async () => {
    const { g, token } = await callingGateway();
    const { invite_id: id } = await ringOk(g, token);
    g.ring!.clock.ms += RING_TTL;
    const res = await g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' });
    expect(res.statusCode).toBe(410);
    expect(code(res)).toBe('invite_expired');
    expect(g.calls!.registry.activeCount).toBe(0);
  });

  it('another user cannot answer (404)', async () => {
    const { g, token } = await callingGateway();
    const { invite_id: id } = await ringOk(g, token);
    expect((await g.send('POST', `/v1/invites/${id}/answer`, { user: 'bob' })).statusCode).toBe(
      404,
    );
  });
});

describe('devices', () => {
  it('keeps at most 5 per user, moves a re-registered token, and deletes', async () => {
    const g = await gateway();
    for (let i = 0; i < 6; i += 1) {
      g.ring!.clock.ms += 1;
      await device(g, 'alice', `phone-000${i}`, `fcm-token-${i}aaaaaaaaaaaaaaaaaa`);
    }
    expect(await g.ring!.stores.devices.list('alice')).toHaveLength(5);
    await device(g, 'bob', 'bob-phone-1', 'fcm-token-5aaaaaaaaaaaaaaaaaa');
    expect((await g.ring!.stores.devices.list('alice')).map((d) => d.fcm_token)).not.toContain(
      'fcm-token-5aaaaaaaaaaaaaaaaaa',
    );
    expect(await g.ring!.stores.devices.list('bob')).toHaveLength(1);
    expect(
      (await g.send('DELETE', '/v1/me/devices/bob-phone-1', { user: 'alice' })).statusCode,
    ).toBe(404);
    expect((await g.send('DELETE', '/v1/me/devices/bob-phone-1', { user: 'bob' })).statusCode).toBe(
      204,
    );
  });
});

describe('delete my data', () => {
  it('removes devices, ring settings, and invites', async () => {
    const g = await gateway();
    const { token } = await setupAgent(g);
    await device(g, 'alice', 'phone-0001', 'fcm-token-aaaaaaaaaaaaaaaa');
    await g.send('PUT', '/v1/me/ring-settings', {
      user: 'alice',
      body: { dnd: false, quiet_hours: null },
    });
    await ringOk(g, token);
    const res = await g.send('DELETE', '/v1/me/data', { user: 'alice' });
    expect(res.statusCode).toBe(200);
    expect(deleteMyDataResponseSchema.parse(res.json()).deleted).toMatchObject({
      devices: 1,
      ring_invites: 1,
    });
    expect(await g.ring!.stores.devices.list('alice')).toEqual([]);
    expect(await g.ring!.stores.invites.list('alice')).toEqual([]);
  });
});

describe('restart', () => {
  it('calls the settled hook once for every outcome and contains hook failures', async () => {
    const g = await gateway();
    const scheduler = new ManualScheduler();
    const outcomes: string[] = [];
    const service = new RingService({
      stores: g.ring!.stores,
      scheduler,
      inCall: () => false,
      logger: recordingLogger(),
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      onSettled: (invite) => {
        outcomes.push(`${invite.status}:${invite.note ?? ''}`);
        return invite.status === 'cancelled'
          ? Promise.reject(new Error('thread unavailable'))
          : Promise.resolve();
      },
    });
    const target = {
      userId: 'alice',
      connectorId: 'con_test',
      localAgent: 'claude-code',
      agentId: `agt_${'a'.repeat(20)}`,
      agentName: 'Agent',
      reason: 'Done',
    };
    const create = async () => {
      const result = await service.ring(target);
      if (!('invite' in result)) throw new Error('ring refused');
      return result.invite.id;
    };
    const answered = await create();
    const claim = await service.claimAnswer('alice', answered);
    if (claim.kind !== 'claimed') throw new Error('answer failed');
    await claim.release(true);
    await service.decline('alice', await create(), 'busy');
    await service.cancel('alice', await create());
    await create();
    scheduler.advance(30_000);
    await service.idle();
    expect(outcomes).toEqual(['answered:', 'declined:busy', 'cancelled:', 'missed:']);
    service.close();
  });
  function service(stores: RingStores, now: number, scheduler = new ManualScheduler()) {
    const history: { userId: string; item: unknown }[] = [];
    const s = new RingService({
      stores,
      history: {
        record: (userId, item) => {
          history.push({ userId, item });
          return Promise.resolve();
        },
        list: () => Promise.resolve([]),
        deleteAllForUser: () => Promise.resolve(0),
        usageRollup: () => Promise.resolve([]),
      },
      inCall: () => false,
      scheduler,
      now: () => new Date(now),
      logger: recordingLogger(),
    });
    return { s, history, scheduler };
  }

  it('stale pending invites become missed on start; fresh ones keep ringing', async () => {
    const rows = new MemoryCollection<InviteRecord>();
    const g = await gateway({ ring: { invites: rows } });
    const { token } = await setupAgent(g);
    const { invite_id: staleId } = await ringOk(g, token);
    await g.ring!.service.idle();
    g.ring!.service.close(); // The gateway stops.

    const stores = { ...g.ring!.stores, invites: new InviteRepository(rows) };
    const later = service(stores, g.ring!.clock.ms + 60_000);
    await later.s.recover();
    const stale = await stores.invites.get('alice', staleId);
    expect(stale?.status).toBe('missed');
    expect(later.history).toEqual([
      {
        userId: 'alice',
        item: expect.objectContaining({ kind: 'missed_invite', call_id: staleId }) as unknown,
      },
    ]);

    // A restart 10 s into a ring: it keeps ringing for the 20 s left.
    g.ring!.clock.ms += 120_000;
    const { invite_id: freshId } = await ringOk(g, token);
    g.ring!.service.close();
    const soon = service(stores, g.ring!.clock.ms + 10_000);
    await soon.s.recover();
    expect((await stores.invites.get('alice', freshId))?.status).toBe('pending');
    soon.scheduler.advance(20_000);
    await soon.s.idle();
    expect((await stores.invites.get('alice', freshId))?.status).toBe('missed');
  });
});
