import { DEVICES_CHANGED_FEATURE, SEALED_CHAT_FEATURE } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from './harness';

/** A removed device reaches the account's computers at once (C3 #11 P4 ruling 2). */

const FLAG_ON = { PRIVATE_CHATS_ENABLED: 'true', THREADS_ENABLED: 'true' };
const key = (n: number) => Buffer.alloc(32, n).toString('base64url');
const devId = (c: string) => `dev_${c.repeat(20)}`;

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup() {
  const g = await startConnectorGateway({ threads: {}, env: FLAG_ON });
  gateways.push(g);
  g.e2e.add('u1', { id: devId('p'), kind: 'phone', name: 'Pixel', public_key: key(2) });
  return g;
}

describe('e2e.devices_changed', () => {
  it('tells only computers that said devices_changed, and only this account', async () => {
    const g = await setup();
    const newer = await g.connect('u1', {
      features: [SEALED_CHAT_FEATURE, DEVICES_CHANGED_FEATURE],
    });
    const older = await g.connect('u1', { features: [SEALED_CHAT_FEATURE] });
    const other = await g.connect('u2', {
      features: [SEALED_CHAT_FEATURE, DEVICES_CHANGED_FEATURE],
    });
    const res = await g.send('DELETE', `/v1/e2e/devices/${devId('p')}`, { user: 'u1' });
    expect(res.statusCode).toBe(204);
    await waitFor(() => newer.connector.devicesChanged() === 1);
    // Give a wrongly sent frame time to arrive before checking it never did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(older.connector.devicesChanged()).toBe(0);
    expect(other.connector.devicesChanged()).toBe(0);
  });

  it('sends nothing when nothing was removed', async () => {
    const g = await setup();
    const newer = await g.connect('u1', {
      features: [SEALED_CHAT_FEATURE, DEVICES_CHANGED_FEATURE],
    });
    const res = await g.send('DELETE', `/v1/e2e/devices/${devId('z')}`, { user: 'u1' });
    expect(res.statusCode).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(newer.connector.devicesChanged()).toBe(0);
  });
});
