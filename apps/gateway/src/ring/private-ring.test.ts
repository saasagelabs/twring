import type { PushPayload } from '@twring/push';
import { afterEach, describe, expect, it } from 'vitest';

import { ManualScheduler, recordingLogger } from '../calls/testing';
import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';
import { PRIVATE_RING_REASON } from '../e2e/guard';

import { RingService } from './service';

/** Private chats (ADR-044): a ring never carries or keeps the agent's own words. */

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function setup(isPrivate: boolean) {
  const g = await startConnectorGateway({ ring: { push: false } });
  gateways.push(g);
  const pushes: PushPayload[] = [];
  const missed: unknown[] = [];
  const scheduler = new ManualScheduler();
  const service = new RingService({
    stores: g.ring!.stores,
    phones: () =>
      Promise.resolve([
        { target: { token: 'tok', platform: 'android' }, forget: () => Promise.resolve() },
      ]),
    push: {
      send: (_target, data) => {
        pushes.push(data);
        return Promise.resolve('sent');
      },
    },
    history: {
      record: (_userId, item) => {
        missed.push(item);
        return Promise.resolve();
      },
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve(false),
      deleteAllForUser: () => Promise.resolve(0),
      usageRollup: () => Promise.resolve([]),
    },
    privateChat: () => Promise.resolve(isPrivate),
    inCall: () => false,
    scheduler,
    logger: recordingLogger(),
    now: () => new Date('2026-10-01T09:00:00.000Z'),
  });
  return { service, pushes, missed, scheduler };
}

const target = {
  userId: 'alice',
  connectorId: 'con_test',
  localAgent: 'claude-code',
  agentId: `agt_${'a'.repeat(20)}`,
  agentName: 'Agent',
  reason: 'Your tax return for 2025 is ready',
};

describe('ring for a private chat', () => {
  it('pushes, stores and records fixed words instead of the reason', async () => {
    const { service, pushes, missed, scheduler } = await setup(true);
    const placed = await service.ring(target);
    if (!('invite' in placed)) throw new Error('ring refused');
    await service.idle();
    expect(placed.invite.reason).toBe(PRIVATE_RING_REASON);
    expect(service.toInvite(placed.invite).reason).toBe(PRIVATE_RING_REASON);
    expect((await service.get('alice', placed.invite.id))?.reason).toBe(PRIVATE_RING_REASON);
    expect(pushes).toHaveLength(1);
    expect(JSON.stringify(pushes)).not.toContain('tax return');
    scheduler.advance(60_000);
    await service.idle();
    expect(JSON.stringify(missed)).not.toContain('tax return');
    expect(missed).toEqual([expect.objectContaining({ reason: PRIVATE_RING_REASON })]);
    service.close();
  });

  it('keeps the agent reason for a chat that is not private', async () => {
    const { service, pushes } = await setup(false);
    const placed = await service.ring(target);
    if (!('invite' in placed)) throw new Error('ring refused');
    await service.idle();
    expect(placed.invite.reason).toBe(target.reason);
    expect(JSON.stringify(pushes)).toContain('tax return');
    service.close();
  });
});
