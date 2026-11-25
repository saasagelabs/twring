import {
  APPROVAL_HOLD_MS,
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  type RelayConnectorMessage,
  type RelayGatewayMessage,
  type SealedControlPayload,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { LocalAgentAdapter, LocalAgentEvent } from '../events';
import { ResultOutbox } from '../outbox';
import { ensureDeviceKey, type E2eConfig, type TrustedDevice } from './keys';
import {
  openIncomingControl,
  ReplayWindow,
  sealOutgoing,
  sealOutgoingControl,
  type SealContext,
} from './sealed';
import { baseConfig } from './test-fixtures';
import { PrivateChats } from './turn';

const AGENT = 'claude-code';
const TITLE = 'Use the key sk-live-SECRET to deploy';
const DESCRIPTION = 'Runs deploy.sh with the production key';
type Approval = Extract<RelayConnectorMessage, { type: 'sealed.approval' }>;
type Decision = Extract<RelayGatewayMessage, { type: 'sealed.decision' }>;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const messageId = () =>
  `msg_${Array.from({ length: 20 }, () => BASE32[Math.floor(Math.random() * 32)]).join('')}`;

function harness(options: { approvals?: number; down?: boolean } = {}) {
  let t = Date.parse('2026-11-25T10:00:00.000Z');
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
  const decided: { id: string; decision: 'approve' | 'deny' }[] = [];
  const logs: string[] = [];
  const waiters = new Map<string, (decision: 'approve' | 'deny') => void>();
  const adapter: LocalAgentAdapter = {
    async *sendTurn(): AsyncIterable<LocalAgentEvent> {
      for (let i = 0; i < (options.approvals ?? 1); i++) {
        const id = `tool-${i}`;
        const answer = new Promise<'approve' | 'deny'>((resolve) => waiters.set(id, resolve));
        yield {
          type: 'approval.required',
          id,
          action: 'other',
          title: TITLE,
          description: DESCRIPTION,
        };
        yield { type: 'text', text: `${await answer} ` };
      }
    },
    close: () => undefined,
    decide: (id, decision) => {
      decided.push({ id, decision });
      waiters.get(id)?.(decision);
    },
  };
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
      runExclusive: (_agent, fn) => fn(),
    },
    send: (frame) => {
      if (options.down) return false;
      sent.push(frame);
      return true;
    },
    outbox: new ResultOutbox(),
    log: (line) => logs.push(line),
    now: () => t,
  });
  const approvals = () => sent.filter((f): f is Approval => f.type === 'sealed.approval');
  const run = {
    phone,
    chats,
    decided,
    logs,
    sent,
    approvals,
    advance: (ms: number) => {
      t += ms;
    },
    removePhone: () => {
      e2e = { ...e2e, devices: [] };
    },
    message: () => ({
      type: 'sealed.message' as const,
      agent: AGENT,
      message_id: messageId(),
      sealed: sealOutgoing(phoneCtx, { text: 'deploy it' }, ++phoneSeq),
    }),
    phoneOpens: (frame: Approval) => {
      const opened = openIncomingControl({ ...phoneCtx, seen: new ReplayWindow() }, frame.sealed);
      if (!opened.ok) throw new Error(opened.reason);
      return opened.payload;
    },
    decision: (
      approvalId: string,
      decision: 'approve' | 'deny',
      ctx: SealContext = phoneCtx,
      seq = ++phoneSeq,
    ): Decision => ({
      type: 'sealed.decision',
      agent: AGENT,
      message_id: messageId(),
      sealed: sealOutgoingControl(
        ctx,
        { kind: 'approval_decision', approval_id: approvalId, decision },
        seq,
      ),
    }),
    phoneCtx,
    reply: (turnId: string) =>
      sent.filter(
        (f): f is Extract<RelayConnectorMessage, { type: 'sealed.reply' }> =>
          f.type === 'sealed.reply' && f.turn_id === turnId,
      ),
  };
  return run;
}

/** Starts a turn and waits until its sealed approval request went out. */
async function asked(run: ReturnType<typeof harness>, count = 1) {
  const message = run.message();
  const turn = run.chats.receive(message);
  await vi.waitFor(() => expect(run.approvals().length).toBe(count));
  const frame = run.approvals().at(-1)!;
  const payload = run.phoneOpens(frame) as Extract<SealedControlPayload, { kind: 'approval' }>;
  return { message, turn, frame, payload };
}

describe('sealed approvals in private turns (C3 #11)', () => {
  it('seals the request to the phone and runs the opened decision', async () => {
    const run = harness();
    const { message, turn, frame, payload } = await asked(run);
    expect(frame.turn_id).toBe(message.message_id);
    expect(payload.kind).toBe('approval');
    expect(payload.title).toBe(TITLE);
    expect(payload.description).toBe(DESCRIPTION);
    expect(payload.approval_id).toMatch(/^apv_[a-z2-7]{26}$/);
    expect(frame.expires_at).toBe(payload.expires_at);
    expect(Date.parse(payload.expires_at) - Date.parse('2026-11-25T10:00:00.000Z')).toBe(
      APPROVAL_HOLD_MS,
    );
    // Nothing readable travels outside the sealed body.
    expect(JSON.stringify(frame)).not.toContain('SECRET');
    expect(JSON.stringify(frame)).not.toContain('deploy.sh');
    await run.chats.receive(run.decision(payload.approval_id, 'approve'));
    await turn;
    expect(run.decided).toEqual([{ id: 'tool-0', decision: 'approve' }]);
    expect(run.logs.join('\n')).not.toContain('SECRET');
    expect(run.logs.join('\n')).not.toMatch(/approve/);
  });

  it('uses a fresh seq for the request, never a reply seq', async () => {
    const run = harness();
    const { turn, frame, payload } = await asked(run);
    await run.chats.receive(run.decision(payload.approval_id, 'deny'));
    await turn;
    const reply = run.reply(frame.turn_id);
    expect(reply.length).toBeGreaterThan(0);
    expect(reply.every((r) => r.sealed.sender_seq !== frame.sealed.sender_seq)).toBe(true);
    expect(frame.sealed.chunk).toBeUndefined();
  });

  it('gives each approval its own random id', async () => {
    const run = harness({ approvals: 2 });
    const first = await asked(run, 1);
    await run.chats.receive(run.decision(first.payload.approval_id, 'approve'));
    await vi.waitFor(() => expect(run.approvals().length).toBe(2));
    const second = run.phoneOpens(run.approvals()[1]!);
    expect(second.approval_id).not.toBe(first.payload.approval_id);
    await run.chats.receive(run.decision(second.approval_id, 'deny'));
    await first.turn;
    expect(run.decided).toEqual([
      { id: 'tool-0', decision: 'approve' },
      { id: 'tool-1', decision: 'deny' },
    ]);
  });

  it('ignores a decision sealed by a stranger key claiming to be the phone', async () => {
    const run = harness();
    const { turn, payload } = await asked(run);
    const stranger = generateSealKeyPair();
    const forged: SealContext = {
      ...run.phoneCtx,
      myPublic: base64urlEncode(stranger.publicKey),
      myPrivate: stranger.privateKey,
    };
    await run.chats.receive(run.decision(payload.approval_id, 'approve', forged, 50));
    expect(run.decided).toEqual([]);
    // The forgery did not use up the phone's seq: the real decision at that seq still counts.
    await run.chats.receive(run.decision(payload.approval_id, 'deny', run.phoneCtx, 50));
    await turn;
    expect(run.decided).toEqual([{ id: 'tool-0', decision: 'deny' }]);
  });

  it('ignores a replayed decision', async () => {
    const run = harness({ approvals: 2 });
    const first = await asked(run, 1);
    const decision = run.decision(first.payload.approval_id, 'approve');
    await run.chats.receive(decision);
    await vi.waitFor(() => expect(run.approvals().length).toBe(2));
    await run.chats.receive(decision);
    expect(run.decided).toEqual([{ id: 'tool-0', decision: 'approve' }]);
    const second = run.phoneOpens(run.approvals()[1]!);
    await run.chats.receive(run.decision(second.approval_id, 'deny'));
    await first.turn;
  });

  it('ignores a decision for another approval id', async () => {
    const run = harness();
    const { turn, payload } = await asked(run);
    await run.chats.receive(run.decision(`apv_${'a'.repeat(26)}`, 'approve'));
    expect(run.decided).toEqual([]);
    expect(run.logs.some((line) => /ignored/.test(line))).toBe(true);
    await run.chats.receive(run.decision(payload.approval_id, 'deny'));
    await turn;
  });

  it('cannot move a decision onto a different approval by editing the frame', async () => {
    const run = harness();
    const { turn, payload } = await asked(run);
    const decision = run.decision(payload.approval_id, 'approve');
    await run.chats.receive({ ...decision, agent: 'other-agent' });
    expect(run.decided).toEqual([]);
    await run.chats.receive(run.decision(payload.approval_id, 'deny'));
    await turn;
  });

  it('ignores a decision after expiry and denies', async () => {
    const run = harness();
    const { turn, payload } = await asked(run);
    run.advance(APPROVAL_HOLD_MS + 1);
    await run.chats.receive(run.decision(payload.approval_id, 'approve'));
    await turn;
    expect(run.decided).toEqual([{ id: 'tool-0', decision: 'deny' }]);
  });

  it('denies when the hold time passes with no answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const run = harness();
      const { turn } = await asked(run);
      vi.advanceTimersByTime(APPROVAL_HOLD_MS);
      await turn;
      expect(run.decided).toEqual([{ id: 'tool-0', decision: 'deny' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('acts on only the first of two racing decisions (verify p148)', async () => {
    const run = harness();
    const { turn, payload } = await asked(run);
    await Promise.all([
      run.chats.receive(run.decision(payload.approval_id, 'approve')),
      run.chats.receive(run.decision(payload.approval_id, 'deny')),
    ]);
    await turn;
    expect(run.decided).toHaveLength(1);
  });

  it('ignores a decision from a phone removed after the request went out (verify p148)', async () => {
    const run = harness();
    const { turn, payload } = await asked(run);
    run.removePhone();
    await run.chats.receive(run.decision(payload.approval_id, 'approve'));
    expect(run.decided).toEqual([]);
    run.advance(APPROVAL_HOLD_MS + 1);
    await run.chats.receive(run.decision(payload.approval_id, 'approve'));
    expect(run.decided).toEqual([]);
    void turn;
  });

  it('a decision after the turn ended does nothing more (verify p148)', async () => {
    const run = harness();
    const { turn, payload } = await asked(run);
    await run.chats.receive(run.decision(payload.approval_id, 'deny'));
    await turn;
    await run.chats.receive(run.decision(payload.approval_id, 'approve'));
    expect(run.decided).toEqual([{ id: 'tool-0', decision: 'deny' }]);
  });

  it('denies at once when the request cannot be sent', async () => {
    const run = harness({ down: true });
    await run.chats.receive(run.message());
    expect(run.decided).toEqual([{ id: 'tool-0', decision: 'deny' }]);
  });
});

describe('Stop during a sealed approval (C3 #11)', () => {
  it('denies the waiting approval and ends the turn with a final chunk', async () => {
    const run = harness();
    const { message, turn } = await asked(run);
    await run.chats.receive({ type: 'sealed.cancel', agent: AGENT, turn_id: message.message_id });
    await turn;
    expect(run.decided).toEqual([{ id: 'tool-0', decision: 'deny' }]);
    expect(run.reply(message.message_id).at(-1)?.final).toBe(true);
  });
});
