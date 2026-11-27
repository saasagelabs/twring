import { randomBytes } from 'node:crypto';

import type { ThreadMessage } from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RingService } from '../ring/service';
import { CredentialCipher, messageKeys } from '../store/cipher';
import type { AgentRecord } from '../store/repositories';
import { ThreadService, ThreadServiceError } from './service';
import { SqliteThreadStore } from './store';

const A = `agt_${'a'.repeat(20)}`;
const rec = (id: string, userId: string): AgentRecord => ({
  id,
  user_id: userId,
  name: 'Hermes',
  protocol: 'cord-connector',
  endpoint_url: 'cord-connector://con_1/hermes',
  voice_id: 'flux-aura-en',
  status: 'ready',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

const stores: SqliteThreadStore[] = [];
const services: ThreadService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const s of services.splice(0)) s.stop();
  for (const st of stores.splice(0)) await st.close();
});

function setup(
  ringResult: Awaited<ReturnType<RingService['ring']>> = { refused: 'owner_unavailable' },
) {
  const store = new SqliteThreadStore(
    ':memory:',
    new CredentialCipher(
      messageKeys({ currentVersion: 1, keys: new Map([[1, randomBytes(32).toString('base64')]]) }),
    ),
  );
  stores.push(store);
  const rings: Parameters<RingService['ring']>[0][] = [];
  const pushes: unknown[] = [];
  const ring = {
    ring: vi.fn((target: Parameters<RingService['ring']>[0]) => {
      rings.push(target);
      return Promise.resolve(ringResult);
    }),
    settings: () => Promise.resolve({ dnd: false, quiet_hours: null }),
    pushMessage: vi.fn((_u: string, payload: unknown) => {
      pushes.push(payload);
      return Promise.resolve(1);
    }),
    nowDate: () => new Date(),
  } as unknown as RingService;
  const frames: unknown[] = [];
  const service = new ThreadService({
    store,
    agents: { get: (u, id) => Promise.resolve(rec(id, u)) },
    agentFactory: () => () => Promise.reject(new Error('no relay in these tests')),
    agentStatus: () => 'offline',
    hasLiveCallToAgent: () => false,
    ring,
    notify: (_u, frame) => frames.push(frame),
  });
  services.push(service);
  return { store, service, rings, pushes, frames };
}
const ask = (t: ReturnType<typeof setup>, requestId = 'req-1', expiresInS = 300) =>
  t.service.createConnectorApproval('u1', A, {
    connectorId: 'con_1',
    agentName: 'Hermes',
    requestId,
    title: 'Run a command',
    description: 'rm -rf build',
    originLabel: 'from Telegram',
    expiresInS,
  });

describe('connector approvals', () => {
  it('stores a card, chat-rings with the title only, and is idempotent', async () => {
    const t = setup({ invite: { id: 'inv_x' } as never });
    const first = await ask(t);
    expect(first.created).toBe(true);
    expect(first.approval.status).toBe('pending');
    expect(t.rings).toEqual([
      expect.objectContaining({
        userId: 'u1',
        agentId: A,
        messageId: first.approval.approval_id,
        reason: 'Needs your OK: Run a command (from Telegram)',
      }),
    ]);
    expect(t.rings[0]).not.toHaveProperty('connectorId');
    expect(t.pushes).toHaveLength(0);
    const again = await ask(t);
    expect(again).toEqual({ approval: first.approval, created: false });
    expect(t.rings).toHaveLength(1);
  });

  it('pushes when the ring is refused', async () => {
    const t = setup({ refused: 'owner_unavailable' });
    await ask(t);
    await vi.waitFor(() => expect(t.pushes).toHaveLength(1));
  });

  it('refuses a private chat and a fourth pending approval', async () => {
    const t = setup();
    for (const id of ['r1', 'r2', 'r3']) await ask(t, id);
    await expect(ask(t, 'r4')).rejects.toEqual(new ThreadServiceError('approvals_full'));
    const p = setup();
    await p.store.setPrivate('u1', A);
    await expect(ask(p)).rejects.toEqual(new ThreadServiceError('private_thread'));
  });

  it('wakes a waiter when the phone allows, with no running turn or relay', async () => {
    const t = setup();
    const { approval } = await ask(t);
    const waiting = t.service.getConnectorApproval('u1', 'con_1', approval.approval_id, 5_000);
    const decided = await t.service.decideApproval('u1', A, approval.approval_id, 'approve');
    expect(decided).toMatchObject({ kind: 'approval', status: 'allowed' });
    expect((await waiting)?.status).toBe('allowed');
  });

  it('refuses a second decision with the current card', async () => {
    const t = setup();
    const { approval } = await ask(t);
    await t.service.decideApproval('u1', A, approval.approval_id, 'deny');
    await expect(
      t.service.decideApproval('u1', A, approval.approval_id, 'approve'),
    ).rejects.toMatchObject({ code: 'approval_conflict', current: { status: 'denied' } });
  });

  it('expires on its timer and refuses a tap after expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t = setup();
    const { approval } = await ask(t, 'req-1', 10);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(
      (await t.service.getConnectorApproval('u1', 'con_1', approval.approval_id, 0))?.status,
    ).toBe('expired');
    await expect(
      t.service.decideApproval('u1', A, approval.approval_id, 'approve'),
    ).rejects.toMatchObject({ code: 'approval_conflict', current: { status: 'expired' } });
  });

  it('expires at read time when the timer did not run (never approves late)', async () => {
    const t = setup();
    const { approval } = await ask(t, 'req-1', 10);
    const later = Date.now() + 11_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect(
      (await t.service.getConnectorApproval('u1', 'con_1', approval.approval_id, 0))?.status,
    ).toBe('expired');
  });

  it('cancel marks it expired and wakes the waiter; other connectors see nothing', async () => {
    const t = setup();
    const { approval } = await ask(t);
    expect(
      await t.service.getConnectorApproval('u1', 'con_2', approval.approval_id, 0),
    ).toBeUndefined();
    expect(
      await t.service.cancelConnectorApproval('u1', 'con_2', approval.approval_id),
    ).toBeUndefined();
    const waiting = t.service.getConnectorApproval('u1', 'con_1', approval.approval_id, 5_000);
    expect(
      (await t.service.cancelConnectorApproval('u1', 'con_1', approval.approval_id))?.status,
    ).toBe('expired');
    expect((await waiting)?.status).toBe('expired');
  });

  it('a server restart expires a pending connector approval', async () => {
    const t = setup();
    const { approval } = await ask(t);
    await t.service.start();
    const card = (await t.store.listMessages('u1', A, { limit: 10 })).messages.find(
      (m): m is Extract<ThreadMessage, { kind: 'approval' }> => m.kind === 'approval',
    );
    expect(card?.status).toBe('expired');
    expect(
      (await t.service.getConnectorApproval('u1', 'con_1', approval.approval_id, 0))?.status,
    ).toBe('expired');
  });

  it('a waiter that leaves stops waiting', async () => {
    const t = setup();
    const { approval } = await ask(t);
    const gone = new AbortController();
    const waiting = t.service.getConnectorApproval(
      'u1',
      'con_1',
      approval.approval_id,
      20_000,
      gone.signal,
    );
    gone.abort();
    expect((await waiting)?.status).toBe('pending');
  });
});
