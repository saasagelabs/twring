import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  type RelayConnectorMessage,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { LocalAgentAdapter, LocalAgentEvent } from '../events';
import { ResultOutbox } from '../outbox';
import { ensureDeviceKey, type E2eConfig, type TrustedDevice } from './keys';
import { openIncoming, ReplayWindow, sealOutgoing, type SealContext } from './sealed';
import { baseConfig } from './test-fixtures';
import { PrivateChats } from './turn';

/** Stop in a private chat (C3 #11): `sealed.cancel` ends or drops the turn on this computer. */

const AGENT = 'claude-code';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const messageId = () =>
  `msg_${Array.from({ length: 20 }, () => BASE32[Math.floor(Math.random() * 32)]).join('')}`;
type Reply = Extract<RelayConnectorMessage, { type: 'sealed.reply' }>;

function harness() {
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
  const logs: string[] = [];
  const started: string[] = [];
  const aborted: string[] = [];
  /** Says "partial", then waits until its signal aborts and throws, as a real adapter does. */
  const adapter: LocalAgentAdapter = {
    async *sendTurn(text: string, signal: AbortSignal): AsyncIterable<LocalAgentEvent> {
      started.push(text);
      yield { type: 'text', text: 'partial' };
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted.push(text);
          reject(new Error('aborted'));
        });
      });
    },
    close: () => undefined,
  };
  // One turn at a time per agent, like the real pool.
  let tail: Promise<void> = Promise.resolve();
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
      return true;
    },
    outbox: new ResultOutbox(),
    log: (line) => logs.push(line),
  });
  const message = (text: string) => ({
    type: 'sealed.message' as const,
    agent: AGENT,
    message_id: messageId(),
    sealed: sealOutgoing(phoneCtx, { text }, ++phoneSeq),
  });
  const replies = (turnId: string) =>
    sent.filter((f): f is Reply => f.type === 'sealed.reply' && f.turn_id === turnId);
  const text = (turnId: string) =>
    replies(turnId)
      .map((r) => {
        const opened = openIncoming({ ...phoneCtx, seen: new ReplayWindow() }, r.sealed);
        if (!opened.ok) throw new Error(opened.reason);
        return opened.payload.text;
      })
      .join('');
  const cancel = (turnId: string, agent = AGENT) =>
    chats.receive({ type: 'sealed.cancel', agent, turn_id: turnId });
  return { chats, message, replies, text, cancel, started, aborted, logs };
}

describe('stop in a private chat (C3 #11)', () => {
  it('aborts a running turn and sends what it has with a final chunk', async () => {
    const run = harness();
    const m = run.message('first');
    const turn = run.chats.receive(m);
    await vi.waitFor(() => expect(run.started).toHaveLength(1));
    await run.cancel(m.message_id);
    await turn;
    expect(run.aborted).toHaveLength(1);
    expect(run.replies(m.message_id).at(-1)?.final).toBe(true);
    expect(run.text(m.message_id)).toBe('partial');
    expect(run.logs.join('\n')).not.toContain('first');
  });

  it('drops a turn still waiting behind another: never runs, sends nothing', async () => {
    const run = harness();
    const a = run.message('a');
    const b = run.message('b');
    const first = run.chats.receive(a);
    const second = run.chats.receive(b);
    await vi.waitFor(() => expect(run.started).toHaveLength(1));
    await run.cancel(b.message_id);
    await run.cancel(a.message_id);
    await Promise.all([first, second]);
    expect(run.started).toHaveLength(1);
    expect(run.replies(b.message_id)).toHaveLength(0);
    expect(run.replies(a.message_id).at(-1)?.final).toBe(true);
  });

  it('ignores an unknown turn id and another agent naming this turn', async () => {
    const run = harness();
    const m = run.message('go');
    const turn = run.chats.receive(m);
    await vi.waitFor(() => expect(run.started).toHaveLength(1));
    await run.cancel(messageId());
    await run.cancel(m.message_id, 'gemini');
    await new Promise((r) => setTimeout(r, 20));
    expect(run.aborted).toHaveLength(0);
    expect(run.logs.filter((l) => l.includes('ignored'))).toHaveLength(2);
    await run.cancel(m.message_id);
    await turn;
  });

  it('forgets a turn once it ends: a late or repeated Stop is ignored and sends nothing', async () => {
    const run = harness();
    const m = run.message('once');
    const turn = run.chats.receive(m);
    await vi.waitFor(() => expect(run.started).toHaveLength(1));
    await run.cancel(m.message_id);
    await run.cancel(m.message_id);
    await turn;
    const after = run.replies(m.message_id).length;
    await run.cancel(m.message_id);
    expect(run.replies(m.message_id)).toHaveLength(after);
    expect(run.replies(m.message_id).filter((r) => r.final)).toHaveLength(1);
    expect(run.aborted).toHaveLength(1);
    expect(run.logs.at(-1)).toContain('ignored');
    expect(run.logs.join('\n')).not.toContain('failed');
  });
});
