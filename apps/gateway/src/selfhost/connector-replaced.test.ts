import { describe, expect, it } from 'vitest';

import { CONNECTOR_REPLACED_MESSAGE, connectorReplacedNotifier } from './connector-replaced';

describe('connectorReplacedNotifier', () => {
  it('tells the owner once an hour per computer, in plain words', async () => {
    const clock = { now: 0 };
    const sent: { userId: string; connectorId: string; text: string }[] = [];
    const notify = connectorReplacedNotifier({
      now: () => clock.now,
      deliver: (userId, connectorId, text) => {
        sent.push({ userId, connectorId, text });
        return Promise.resolve();
      },
    });
    await notify({ connectorId: 'con_a', userId: 'asha', name: 'Laptop' });
    await notify({ connectorId: 'con_a', userId: 'asha', name: 'Laptop' });
    await notify({ connectorId: 'con_b', userId: 'asha', name: 'Desk' });
    clock.now += 60 * 60_000;
    await notify({ connectorId: 'con_a', userId: 'asha', name: 'Laptop' });
    expect(sent.map((s) => s.connectorId)).toEqual(['con_a', 'con_b', 'con_a']);
    expect(sent[0]!.text).toBe(
      "Your computer link was opened from another place. If that wasn't you, link your computer again.",
    );
    expect(CONNECTOR_REPLACED_MESSAGE).toBe(sent[0]!.text);
  });

  it('a delivery failure never throws', async () => {
    const notify = connectorReplacedNotifier({
      now: () => 0,
      deliver: () => Promise.reject(new Error('disk full')),
    });
    await expect(notify({ connectorId: 'c', userId: 'u', name: 'n' })).resolves.toBeUndefined();
  });
});
