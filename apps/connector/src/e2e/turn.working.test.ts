import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  SEALED_WORKING_FEATURE,
  SEALED_WORKING_INTERVAL_MS,
  type RelayConnectorMessage,
} from '@twring/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocalAgentAdapter, LocalAgentEvent } from '../events';
import { ResultOutbox } from '../outbox';
import { ensureDeviceKey, type E2eConfig, type TrustedDevice } from './keys';
import { ReplayWindow, sealOutgoing, type SealContext } from './sealed';
import { baseConfig } from './test-fixtures';
import { helloFeatures, PrivateChats } from './turn';

/** The working frame (ADR-045): a private turn tells the server it is alive every 20 s. */

const AGENT = 'claude-code';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const messageId = () =>
  `msg_${Array.from({ length: 20 }, () => BASE32[Math.floor(Math.random() * 32)]).join('')}`;

function setup(options: { supports?: boolean; sendOk?: boolean } = {}) {
  const phoneKeys = generateSealKeyPair();
  const phone: TrustedDevice = {
    id: deviceIdFor(phoneKeys.publicKey),
    kind: 'phone',
    name: 'Pixel',
    public_key: base64urlEncode(phoneKeys.publicKey),
    verified_at: '2026-11-24T00:00:00.000Z',
  };
  let e2e: E2eConfig = { ...ensureDeviceKey(baseConfig).config.e2e!, devices: [phone] };
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
    myDeviceId: phone.id,
    myPublic: phone.public_key,
    myPrivate: phoneKeys.privateKey,
    trusted: [computer],
    seen: new ReplayWindow(),
  };
  let phoneSeq = 0;
  const sent: RelayConnectorMessage[] = [];
  const started: string[] = [];
  const finishers: Array<() => void> = [];
  /** Runs until the test calls the next finisher. */
  const adapter: LocalAgentAdapter = {
    async *sendTurn(text: string): AsyncIterable<LocalAgentEvent> {
      started.push(text);
      await new Promise<void>((resolve) => finishers.push(resolve));
      yield { type: 'text', text: 'done' };
    },
    close: () => undefined,
  };
  let tail: Promise<void> = Promise.resolve();
  const outbox = new ResultOutbox();
  const hold = vi.spyOn(outbox, 'hold');
  const chats = new PrivateChats({
    connectorId: baseConfig.connector_id,
    e2e: () => e2e,
    persist: (change) => {
      e2e = change(e2e);
      return Promise.resolve(e2e);
    },
    pool: {
      acquire: (agent) => (agent === AGENT ? adapter : undefined),
      release: () => undefined,
      runExclusive: (_agent, fn) => {
        const run = tail.then(fn);
        tail = run.catch(() => undefined);
        return run;
      },
    },
    send: (frame) => {
      sent.push(frame);
      return options.sendOk ?? true;
    },
    gatewaySupports: (feature) => (options.supports ?? true) && feature === SEALED_WORKING_FEATURE,
    outbox,
  });
  const message = (text: string) => ({
    type: 'sealed.message' as const,
    agent: AGENT,
    message_id: messageId(),
    sealed: sealOutgoing(phoneCtx, { text }, ++phoneSeq),
  });
  const working = (turnId?: string) =>
    sent.filter(
      (f) => f.type === 'sealed.working' && (turnId === undefined || f.turn_id === turnId),
    );
  return { chats, message, working, started, finishers, hold, e2e: () => e2e };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the working frame', () => {
  it('sends a working frame every 20 s while the agent runs', async () => {
    const run = setup();
    const m = run.message('go');
    const turn = run.chats.receive(m);
    await vi.waitFor(() => expect(run.started).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(run.working(m.message_id)).toHaveLength(2);
    expect(run.working()[0]).toEqual({
      type: 'sealed.working',
      agent: AGENT,
      turn_id: m.message_id,
    });
    run.finishers[0]!();
    await turn;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.working()).toHaveLength(2);
  });

  it('keeps a queued turn alive while another runs', async () => {
    const run = setup();
    const a = run.message('a');
    const b = run.message('b');
    const first = run.chats.receive(a);
    const second = run.chats.receive(b);
    await vi.waitFor(() => expect(run.started).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(SEALED_WORKING_INTERVAL_MS + 1);
    expect(run.working(b.message_id)).toHaveLength(1);
    expect(run.started).toHaveLength(1);
    run.finishers[0]!();
    await first;
    await vi.waitFor(() => expect(run.started).toHaveLength(2));
    run.finishers[1]!();
    await second;
  });

  it('sends no working frame unless the gateway said sealed_working', async () => {
    const run = setup({ supports: false });
    const m = run.message('go');
    const turn = run.chats.receive(m);
    await vi.waitFor(() => expect(run.started).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.working()).toHaveLength(0);
    run.finishers[0]!();
    await turn;
  });

  it('stops sending after a cancel', async () => {
    const run = setup();
    const m = run.message('go');
    const turn = run.chats.receive(m);
    await vi.waitFor(() => expect(run.started).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(SEALED_WORKING_INTERVAL_MS + 1);
    expect(run.working()).toHaveLength(1);
    await run.chats.receive({ type: 'sealed.cancel', agent: AGENT, turn_id: m.message_id });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.working()).toHaveLength(1);
    run.finishers[0]!();
    await turn;
  });

  it('a failed working send is not held', async () => {
    const run = setup({ sendOk: false });
    const m = run.message('go');
    const turn = run.chats.receive(m);
    await vi.waitFor(() => expect(run.started).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(SEALED_WORKING_INTERVAL_MS + 1);
    expect(run.working()).toHaveLength(1);
    expect(run.hold).not.toHaveBeenCalled();
    run.finishers[0]!();
    await turn;
  });

  it('hello features include sealed_working when a phone is trusted', () => {
    const run = setup();
    expect(helloFeatures(run.e2e())).toContain(SEALED_WORKING_FEATURE);
    expect(helloFeatures(undefined)).not.toContain(SEALED_WORKING_FEATURE);
  });
});
