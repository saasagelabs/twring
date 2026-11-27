import {
  base64urlDecode,
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  messageAad,
  unwrapKey,
  type RelayConnectorMessage,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { LocalAgentAdapter, LocalAgentEvent } from '../events';
import { ResultOutbox } from '../outbox';
import { ensureDeviceKey, type E2eConfig, type TrustedDevice } from './keys';
import { ReplayWindow, sealOutgoing, type SealContext } from './sealed';
import { devicesChangedTrigger, reconcileDevices } from './sync';
import { baseConfig } from './test-fixtures';
import { PrivateChats } from './turn';

/** A phone removed while the agent answers (C3 #11 P4a): later pieces are not wrapped to it. */

const AGENT = 'claude-code';
type Reply = Extract<RelayConnectorMessage, { type: 'sealed.reply' }>;

const phoneDevice = (): { device: TrustedDevice; privateKey: Uint8Array } => {
  const keys = generateSealKeyPair();
  return {
    privateKey: keys.privateKey,
    device: {
      id: deviceIdFor(keys.publicKey),
      kind: 'phone',
      name: 'Pixel',
      public_key: base64urlEncode(keys.publicKey),
      verified_at: '2026-11-24T00:00:00.000Z',
    },
  };
};

describe('revoke while a reply is being sealed', () => {
  it('wraps the pieces sealed after the sync only to the devices still trusted', async () => {
    const phone = phoneDevice();
    const second = phoneDevice();
    let e2e: E2eConfig = {
      ...ensureDeviceKey(baseConfig).config.e2e!,
      devices: [phone.device, second.device],
    };
    const computer: TrustedDevice = {
      id: e2e.device_id,
      kind: 'computer',
      name: 'Laptop',
      public_key: e2e.public_key,
      verified_at: '2026-11-24T00:00:00.000Z',
    };
    const phoneCtx: SealContext = {
      accountId: baseConfig.connector_id,
      agentId: AGENT,
      myDeviceId: phone.device.id,
      myPublic: phone.device.public_key,
      myPrivate: phone.privateKey,
      trusted: [computer],
      seen: new ReplayWindow(),
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const adapter: LocalAgentAdapter = {
      async *sendTurn(): AsyncIterable<LocalAgentEvent> {
        yield { type: 'text', text: 'before ' };
        await gate;
        yield { type: 'text', text: 'after' };
      },
      close: () => undefined,
    };
    const sent: RelayConnectorMessage[] = [];
    let clock = 0;
    const chats = new PrivateChats({
      connectorId: baseConfig.connector_id,
      e2e: () => e2e,
      persist: (change) => {
        e2e = change(e2e);
        return Promise.resolve(e2e);
      },
      pool: {
        acquire: () => adapter,
        release: () => undefined,
        runExclusive: (_agent, fn) => fn(),
      },
      send: (frame) => {
        sent.push(frame);
        return true;
      },
      outbox: new ResultOutbox(),
      // Each read is minutes later, so every piece of text goes out as its own chunk.
      now: () => (clock += 10 * 60_000),
    });
    const turn = chats.receive({
      type: 'sealed.message',
      agent: AGENT,
      message_id: `msg_${'a'.repeat(20)}`,
      sealed: sealOutgoing(phoneCtx, { text: 'hi' }, 1),
    });
    const replies = () => sent.filter((f): f is Reply => f.type === 'sealed.reply');
    await vi.waitFor(() => expect(replies()).toHaveLength(1));
    // The sync a removal starts lands while the agent is still answering.
    const synced = reconcileDevices(
      e2e.devices,
      [
        {
          ...second.device,
          added_at: '2026-11-24T00:00:00.000Z',
          revoked_at: '2026-11-25T00:00:00.000Z',
        },
      ],
      e2e.device_id,
    );
    e2e = { ...e2e, devices: synced.trusted };
    release();
    await turn;
    const keys = replies().map((r) => r.sealed.keys.map((k) => k.device));
    expect(keys[0]).toContain(second.device.id);
    expect(keys.length).toBeGreaterThan(1);
    for (const later of keys.slice(1)) {
      expect(later).not.toContain(second.device.id);
      expect(later).toContain(phone.device.id);
    }
    // The pieces after the removal use a new message key the removed phone never held.
    const keyOf = (r: Reply) =>
      unwrapKey(
        r.sealed.keys.find((k) => k.device === phone.device.id)!.wrapped,
        phone.privateKey,
        base64urlDecode(computer.public_key),
        messageAad({
          accountId: baseConfig.connector_id,
          agentId: AGENT,
          senderDevice: r.sealed.sender_device,
          senderSeq: r.sealed.sender_seq,
          chunk: r.sealed.chunk!.index,
        }),
      );
    const [first, ...rest] = replies().map((r) => Buffer.from(keyOf(r)));
    for (const later of rest) expect(later.equals(first!)).toBe(false);
  });
});

describe('devicesChangedTrigger', () => {
  it('runs one sync for a burst, and one more for a frame during a sync', async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      let finish!: () => void;
      const trigger = devicesChangedTrigger({
        run: () => {
          runs++;
          return new Promise<void>((resolve) => (finish = resolve));
        },
        enabled: () => true,
        delayMs: 100,
      });
      trigger();
      trigger();
      trigger();
      await vi.advanceTimersByTimeAsync(100);
      expect(runs).toBe(1);
      trigger();
      await vi.advanceTimersByTimeAsync(100);
      expect(runs).toBe(1);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toBe(2);
      finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores the frame while private chats are off on this computer', async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const trigger = devicesChangedTrigger({
        run: () => Promise.resolve(void runs++),
        enabled: () => false,
        delayMs: 100,
      });
      trigger();
      await vi.advanceTimersByTimeAsync(500);
      expect(runs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
