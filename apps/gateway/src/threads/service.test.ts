import { randomBytes, randomUUID } from 'node:crypto';

import { AdapterError, type TwringAgentAdapter } from '@twring/agent-adapter';
import {
  APPROVAL_HOLD_MS,
  type AgentEvent,
  type CallHistoryItem,
  type ThreadSocketFrame,
  type UserTurn,
} from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../store/repositories';
import { RingService } from '../ring/service';
import { DeviceRepository, InviteRepository, RingSettingsRepository } from '../ring/store';
import { MemoryCollection } from '../store/collection';
import { ManualScheduler, recordingLogger } from '../calls/testing';
import { CredentialCipher, messageKeys } from '../store/cipher';
import { SqliteThreadStore } from './store';
import { ThreadService } from './service';

const agent = `agt_${'a'.repeat(20)}`;
const other = `agt_${'b'.repeat(20)}`;
const record = (id = agent): AgentRecord => ({
  id,
  user_id: 'owner',
  name: 'Agent',
  protocol: 'cord-rest',
  endpoint_url: 'https://example.com/agent',
  voice_id: 'flux-aura-en',
  status: 'ready',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});
const event = <T extends AgentEvent['type']>(
  type: T,
  fields: Omit<Extract<AgentEvent, { type: T }>, 'type' | 'event_id' | 'turn_id'>,
): AgentEvent => ({ type, event_id: randomUUID(), turn_id: 'agent-turn', ...fields }) as AgentEvent;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

class ScriptedAdapter implements TwringAgentAdapter {
  readonly name = 'scripted';
  readonly capabilities = {
    streamingText: true,
    cancellation: true,
    resumableStream: false,
    activityEvents: true,
    toolEvents: true,
    approvals: true,
    conversationResume: true,
    serverInitiatedCalls: false,
  };
  readonly turns: UserTurn[] = [];
  readonly cancellations: [string, string][] = [];
  readonly approvals: [string, string, string][] = [];
  readonly gate = deferred();
  connectError?: AdapterError;
  events: AgentEvent[] = [];
  held = false;
  connect(): Promise<void> {
    return this.connectError ? Promise.reject(this.connectError) : Promise.resolve();
  }
  async *sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.turns.push(turn);
    for (const item of this.events) {
      if (signal.aborted) return;
      yield item;
    }
    if (this.held)
      await Promise.race([
        this.gate.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
      ]);
  }
  cancelTurn(
    turnId: string,
    reason: 'superseded' | 'barge_in' | 'call_ended' | 'timeout',
  ): Promise<void> {
    this.cancellations.push([turnId, reason]);
    return Promise.resolve();
  }
  decideApproval(turnId: string, approvalId: string, decision: 'approve' | 'deny'): Promise<void> {
    this.approvals.push([turnId, approvalId, decision]);
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.gate.resolve();
    return Promise.resolve();
  }
}

const stores: SqliteThreadStore[] = [];
const allAdapters: ScriptedAdapter[] = [];
const cases: { service: ThreadService; logs: unknown[] }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const { service } of cases) {
    service.stop();
    await service.deleteAllForUser('owner');
  }
  for (const adapter of allAdapters.splice(0)) adapter.gate.resolve();
  for (const { logs } of cases.splice(0)) {
    await until(() => {
      const entries = logs as [Record<string, unknown>, string][];
      return (
        entries.filter(([, message]) => message === 'thread_turn_started').length ===
        entries.filter(([, message]) => message === 'thread_turn_finished').length
      );
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const store of stores.splice(0)) await store.close();
});
function setup(
  configure: (adapter: ScriptedAdapter) => void = () => undefined,
  delivery?: { ring: RingService; isFocused?: () => boolean },
  timeouts: { totalMs?: number; idleMs?: number } = {},
) {
  const store = new SqliteThreadStore(
    ':memory:',
    new CredentialCipher(
      messageKeys({ currentVersion: 1, keys: new Map([[1, randomBytes(32).toString('base64')]]) }),
    ),
  );
  stores.push(store);
  const adapters: ScriptedAdapter[] = [];
  const frames: ThreadSocketFrame[] = [];
  const logs: unknown[] = [];
  let online = true;
  let call = false;
  const service = new ThreadService({
    store,
    agents: { get: (userId, id) => Promise.resolve(userId === 'owner' ? record(id) : undefined) },
    agentFactory: () => () => {
      const adapter = new ScriptedAdapter();
      configure(adapter);
      adapters.push(adapter);
      allAdapters.push(adapter);
      return Promise.resolve(adapter);
    },
    agentStatus: () => (online ? 'online' : 'offline'),
    hasLiveCallToAgent: () => call,
    ...(delivery && { ring: delivery.ring, isFocused: () => delivery.isFocused?.() ?? false }),
    notify: (_user, frame) => frames.push(frame),
    log: {
      info: (data, msg) => logs.push([data, msg]),
      warn: (data, msg) => logs.push([data, msg]),
    },
    timeouts: { firstEventMs: 40, idleMs: 1_000, connectMs: 1_000, totalMs: 2_000, ...timeouts },
  });
  cases.push({ service, logs });
  return {
    store,
    service,
    frames,
    adapters,
    logs,
    setOnline: (value: boolean) => {
      online = value;
    },
    setCall: (value: boolean) => {
      call = value;
    },
  };
}
describe('typed approvals', () => {
  const approval = (id: string) =>
    event('approval.required', {
      approval_id: id,
      action: 'other',
      title: 'Run the report',
      description: 'Shares private data',
    });
  const pending = async (store: SqliteThreadStore) => {
    let found:
      | Extract<
          Awaited<ReturnType<typeof store.listMessages>>['messages'][number],
          { kind: 'approval' }
        >
      | undefined;
    await until(async () => {
      const rows = (await store.listMessages('owner', agent, { limit: 10 })).messages;
      const match = rows.find((row) => row.kind === 'approval');
      if (match?.kind === 'approval') found = match;
      return !!found;
    });
    return found!;
  };
  it('holds and approves once; another owner cannot decide', async () => {
    const t = setup((adapter) => {
      adapter.events = [approval('apr-1')];
      adapter.held = true;
    });
    await send(t.service, agent, 'question');
    const card = await pending(t.store);
    expect(card).toMatchObject({ status: 'pending', title: 'Run the report' });
    await expect(
      t.service.decideApproval('other', agent, card.id, 'approve'),
    ).rejects.toMatchObject({ code: 'approval_not_found' });
    expect(await t.service.decideApproval('owner', agent, card.id, 'approve')).toMatchObject({
      status: 'allowed',
    });
    expect(t.adapters[0]?.approvals).toMatchObject([[expect.any(String), 'apr-1', 'approve']]);
    await expect(t.service.decideApproval('owner', agent, card.id, 'deny')).rejects.toMatchObject({
      code: 'approval_conflict',
      current: { status: 'allowed' },
    });
    t.adapters[0]?.gate.resolve();
  });
  it('denies explicitly and expires when a turn ends', async () => {
    const t = setup((adapter) => {
      adapter.events = [approval('apr-2')];
      adapter.held = true;
    });
    await send(t.service, agent, 'question');
    const card = await pending(t.store);
    expect(await t.service.decideApproval('owner', agent, card.id, 'deny')).toMatchObject({
      status: 'denied',
    });
    t.adapters[0]?.gate.resolve();
    await until(
      async () => (await t.store.findMessageById('owner', agent, card.id))?.kind === 'approval',
    );
    const otherTurn = setup((adapter) => {
      adapter.events = [approval('apr-3')];
    });
    await send(otherTurn.service, agent, 'question');
    const ended = await pending(otherTurn.store);
    await until(async () => {
      const latest = await otherTurn.store.findMessageById('owner', agent, ended.id);
      return latest?.kind === 'approval' && latest.status === 'expired';
    });
    expect(otherTurn.adapters[0]?.approvals).toMatchObject([[expect.any(String), 'apr-3', 'deny']]);
  });
  it('denies a second request while the first is pending', async () => {
    const t = setup((adapter) => {
      adapter.events = [approval('apr-1'), approval('apr-2')];
      adapter.held = true;
    });
    await send(t.service, agent, 'question');
    const card = await pending(t.store);
    await until(() => t.adapters[0]?.approvals.length === 1);
    expect(t.adapters[0]?.approvals[0]).toMatchObject([expect.any(String), 'apr-2', 'deny']);
    expect(
      (await t.store.listMessages('owner', agent, { limit: 10 })).messages.filter(
        (row) => row.kind === 'approval',
      ),
    ).toHaveLength(1);
    await t.service.decideApproval('owner', agent, card.id, 'deny');
    t.adapters[0]?.gate.resolve();
  });
  it('keeps the turn alive past idle and denies after the ten-minute hold', async () => {
    vi.useFakeTimers();
    const t = setup(
      (adapter) => {
        adapter.events = [approval('apr-timeout')];
        adapter.held = true;
      },
      undefined,
      { totalMs: APPROVAL_HOLD_MS + 20_000 },
    );
    await send(t.service, agent, 'question');
    await vi.advanceTimersByTimeAsync(1);
    const card = (await t.store.listMessages('owner', agent, { limit: 10 })).messages.find(
      (row) => row.kind === 'approval',
    );
    expect(card).toMatchObject({ status: 'pending' });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await t.store.findMessageById('owner', agent, card!.id)).toMatchObject({
      status: 'pending',
    });
    expect(t.adapters[0]?.cancellations).toEqual([]);
    await vi.advanceTimersByTimeAsync(APPROVAL_HOLD_MS - 1_500);
    expect(await t.store.findMessageById('owner', agent, card!.id)).toMatchObject({
      status: 'expired',
    });
    expect(t.adapters[0]?.approvals).toMatchObject([[expect.any(String), 'apr-timeout', 'deny']]);
    t.adapters[0]?.gate.resolve();
    await vi.advanceTimersByTimeAsync(1);
  });
  it('pushes an approval unless the chat is focused', async () => {
    const stores = {
      devices: new DeviceRepository(new MemoryCollection()),
      settings: new RingSettingsRepository(new MemoryCollection()),
      invites: new InviteRepository(new MemoryCollection()),
    };
    await stores.devices.upsert({
      user_id: 'owner',
      device_id: 'phone-0001',
      fcm_token: 'fcm-token-aaaaaaaaaaaaaaaa',
      platform: 'android',
      app_variant: 'beta',
      updated_at: new Date().toISOString(),
    });
    const pushes: unknown[] = [];
    const ring = new RingService({
      stores,
      scheduler: new ManualScheduler(),
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      inCall: () => false,
      push: {
        send: (_target, data) => {
          pushes.push(data);
          return Promise.resolve('sent');
        },
      },
      logger: recordingLogger(),
    });
    let focused = false;
    const t = setup(
      (adapter) => {
        adapter.events = [approval('apr-push')];
        adapter.held = true;
      },
      { ring, isFocused: () => focused },
    );
    await send(t.service, agent, 'question');
    const card = await pending(t.store);
    await until(() => pushes.length === 1);
    expect(pushes[0]).toMatchObject({
      type: 'cord.message',
      preview: 'Needs your OK: Run the report',
      message_id: card.id,
      silent: '0',
    });
    await t.service.decideApproval('owner', agent, card.id, 'deny');
    t.adapters[0]?.gate.resolve();
    await until(
      () =>
        t.logs.filter((entry) => (entry as [unknown, string])[1] === 'thread_turn_finished')
          .length === 1,
    );
    focused = true;
    await send(t.service, agent, 'again');
    await until(
      async () =>
        (await t.store.listMessages('owner', agent, { limit: 10 })).messages.filter(
          (row) => row.kind === 'approval',
        ).length === 2,
    );
    const second = await pending(t.store);
    expect(pushes).toHaveLength(1);
    await t.service.decideApproval('owner', agent, second.id, 'deny');
    t.adapters[1]?.gate.resolve();
  });
});

describe('call history in threads', () => {
  const finished: CallHistoryItem = {
    call_id: `cal_${'a'.repeat(20)}`,
    agent_id: agent,
    agent_name: 'Agent',
    started_at: '2026-10-13T10:00:00.000Z',
    duration_s: 259,
    outcome: 'completed',
    end_reason: 'hangup',
  };

  it('adds one call message and publishes it', async () => {
    const { service, store, frames } = setup();
    await service.recordCall('owner', finished);
    const page = await store.listMessages('owner', agent, { limit: 10 });
    expect(page.messages).toMatchObject([
      { kind: 'call', call_id: finished.call_id, duration_s: 259, outcome: 'completed' },
    ]);
    expect(frames).toMatchObject([{ type: 'message.upserted', message: page.messages[0] }]);
  });

  it('skips missed invites, which already have ring messages', async () => {
    const { service, store, frames } = setup();
    await service.recordCall('owner', { ...finished, kind: 'missed_invite' });
    expect((await store.listMessages('owner', agent, { limit: 10 })).messages).toEqual([]);
    expect(frames).toEqual([]);
  });
});
describe('detached results', () => {
  const target = { connectorId: 'con_test', localAgent: 'claude-code', agentName: 'Agent' };
  function fixture(configure?: (adapter: ScriptedAdapter) => void) {
    const stores = {
      devices: new DeviceRepository(new MemoryCollection()),
      settings: new RingSettingsRepository(new MemoryCollection()),
      invites: new InviteRepository(new MemoryCollection()),
    };
    const pushes: unknown[] = [];
    const ring = new RingService({
      requireRingPhone: true,
      stores,
      scheduler: new ManualScheduler(),
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      inCall: () => false,
      push: {
        send: (_target, data) => {
          pushes.push(data);
          return Promise.resolve('sent');
        },
      },
      logger: recordingLogger(),
    });
    let focused = false;
    const app = setup(configure, { ring, isFocused: () => focused });
    const deliver = (
      key: string,
      origin: 'call_turn' | 'text_turn' | 'agent' = 'call_turn',
      turnId?: string,
    ) =>
      app.service.deliverResult('owner', agent, {
        text: 'Finished. Full detail follows.',
        origin,
        ...(turnId && { turnId }),
        idempotencyKey: key,
        target,
      });
    return {
      ...app,
      stores,
      pushes,
      deliver,
      setFocused: (value: boolean) => {
        focused = value;
      },
    };
  }

  it('stores before ringing and suppresses a repeated delivery', async () => {
    const f = fixture();
    await f.stores.devices.upsert({
      user_id: 'owner',
      device_id: 'phone-0001',
      fcm_token: 'fcm-token-aaaaaaaaaaaaaaaa',
      platform: 'android',
      app_variant: 'beta',
      updated_at: new Date().toISOString(),
    });
    const first = await f.deliver('call-one');
    expect(first.delivery).toBe('ring');
    expect((await f.stores.invites.list('owner'))[0]?.reason).toBe('Finished.');
    expect((await f.store.listMessages('owner', agent, { limit: 20 })).messages[0]?.kind).toBe(
      'agent_text',
    );
    const retry = await f.deliver('call-one');
    expect(retry).toEqual({ messageId: first.messageId, delivery: 'none', created: false });
    expect((await f.stores.invites.list('owner')).length).toBe(1);
  });

  it('falls back from DND to silent push, and message and typed results never ring', async () => {
    const f = fixture();
    await f.stores.devices.upsert({
      user_id: 'owner',
      device_id: 'phone-0001',
      fcm_token: 'fcm-token-aaaaaaaaaaaaaaaa',
      platform: 'android',
      app_variant: 'beta',
      updated_at: new Date().toISOString(),
    });
    await f.stores.settings.put('owner', { dnd: true, quiet_hours: null });
    expect((await f.deliver('dnd')).delivery).toBe('push');
    expect(f.pushes.at(-1)).toMatchObject({ type: 'cord.message', silent: '1' });
    expect((await f.store.listMessages('owner', agent, { limit: 20 })).messages[0]?.kind).toBe(
      'agent_text',
    );
    await f.stores.settings.put('owner', {
      dnd: false,
      quiet_hours: null,
      after_call_result: 'message',
    });
    expect((await f.deliver('message')).delivery).toBe('push');
    expect((await f.deliver('typed', 'text_turn')).delivery).toBe('push');
    expect((await f.deliver('agent', 'agent')).delivery).toBe('push');
    expect((await f.stores.invites.list('owner')).length).toBe(0);
    f.setFocused(true);
    expect((await f.deliver('focused', 'agent')).delivery).toBe('none');
    f.setCall(true);
    expect((await f.deliver('live')).delivery).toBe('none');
  });

  it('pushes a saved after-call result when no phone can ring', async () => {
    const f = fixture();
    await f.stores.devices.upsert({
      user_id: 'owner',
      device_id: 'iphone-0001',
      fcm_token: 'fcm-token-iphoneaaaaaaaaaa',
      platform: 'ios',
      app_variant: 'beta',
      updated_at: new Date().toISOString(),
    });
    const result = await f.deliver('no-ring-phone');
    expect(result.delivery).toBe('push');
    expect(await f.stores.invites.list('owner')).toEqual([]);
    expect(f.pushes.at(-1)).toMatchObject({
      type: 'cord.message',
      message_id: result.messageId,
    });
  });

  it('notifies a typed answer unless its chat is on screen (device review 2026-10-13)', async () => {
    const f = fixture((adapter) => {
      adapter.events = [
        event('run.started', {}),
        event('text.delta', { message_id: 'reply', delta: 'Here is the answer.\nMore detail.' }),
        event('done', { status: 'completed' }),
      ];
    });
    await f.stores.devices.upsert({
      user_id: 'owner',
      device_id: 'phone-0002',
      fcm_token: 'fcm-token-bbbbbbbbbbbbbbbb',
      platform: 'android',
      app_variant: 'beta',
      updated_at: new Date().toISOString(),
    });
    await send(f.service, agent, 'question', randomUUID());
    await until(() => f.pushes.length === 1);
    expect(f.pushes[0]).toMatchObject({
      type: 'cord.message',
      preview: 'Here is the answer.',
      silent: '0',
    });
    f.setFocused(true);
    await send(f.service, agent, 'another', randomUUID());
    await until(async () =>
      (await messages(f.store)).some(
        (row) => row.kind === 'user_text' && row.text === 'another' && row.status === 'answered',
      ),
    );
    expect(f.pushes).toHaveLength(1);
  });

  it('marks an interrupted turn answered when its late result arrives', async () => {
    const f = fixture();
    const user = await f.store.appendUserMessage('owner', agent, {
      clientId: randomUUID(),
      text: 'work',
      status: 'sent',
    });
    await f.store.updateUserMessage('owner', user.message.id, {
      status: 'interrupted',
      turnId: 'late-turn',
    });
    await f.deliver('late-result', 'text_turn', 'late-turn');
    expect(await f.store.findUserMessageByTurn('owner', 'late-turn')).toMatchObject({
      status: 'answered',
    });
  });

  it('pushes the saved full result after a declined or missed result ring', async () => {
    const f = fixture();
    await f.stores.devices.upsert({
      user_id: 'owner',
      device_id: 'phone-0001',
      fcm_token: 'fcm-token-aaaaaaaaaaaaaaaa',
      platform: 'android',
      app_variant: 'beta',
      updated_at: new Date().toISOString(),
    });
    const delivered = await f.deliver('settled');
    const invite = (await f.stores.invites.list('owner'))[0]!;
    expect(invite.message_id).toBe(delivered.messageId);
    await f.service.pushSettledResult({ ...invite, status: 'declined' });
    expect(f.pushes.at(-1)).toMatchObject({
      type: 'cord.message',
      message_id: delivered.messageId,
    });
  });
  it('records each settled ring in the matching chat', async () => {
    const f = fixture();
    for (const status of ['answered', 'declined', 'missed', 'cancelled'] as const) {
      await f.service.recordRing({
        user_id: 'owner',
        agent_id: agent,
        id: `inv_${status[0]!.repeat(26)}`,
        reason: 'Work finished',
        status,
        ...(status === 'declined' && { note: 'busy' }),
      });
    }
    const page = await f.store.listMessages('owner', agent, { limit: 20 });
    expect(page.messages.filter((message) => message.kind === 'ring')).toHaveLength(4);
    expect(
      page.messages.find((message) => message.kind === 'ring' && message.outcome === 'declined'),
    ).toMatchObject({ note: 'busy', reason: 'Work finished' });
  });
});

const send = (
  service: ThreadService,
  id = agent,
  text = 'private user text',
  clientId = randomUUID(),
) => service.send('owner', id, { clientId, text });
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not reached');
}
const messages = (store: SqliteThreadStore, id = agent) =>
  store.listMessages('owner', id, { limit: 100 }).then((page) => page.messages);

describe('ThreadService', () => {
  it('stores and publishes one session notice before a typed reply, then dedupes it', async () => {
    const t = setup((adapter) => {
      adapter.events = [
        event('run.started', { new_session: true }),
        event('text.delta', { message_id: 'reply', delta: 'fresh answer' }),
        event('done', { status: 'completed' }),
      ];
    });
    await send(t.service);
    await until(async () => (await messages(t.store)).some((row) => row.kind === 'agent_text'));
    await t.service.noteNewSession('owner', agent);
    const ordered = (await messages(t.store)).sort((a, b) => a.seq - b.seq);
    expect(ordered.map((row) => row.kind)).toEqual(['user_text', 'notice', 'agent_text']);
    expect(ordered[1]).toMatchObject({ code: 'new_session' });
    expect(
      t.frames.some(
        (frame) => frame.type === 'message.upserted' && frame.message.kind === 'notice',
      ),
    ).toBe(true);
  });

  it('does not fail the turn when a notice cannot be stored', async () => {
    const t = setup();
    vi.spyOn(t.store, 'appendMessage').mockRejectedValueOnce(new Error('store unavailable'));
    await expect(t.service.noteNewSession('owner', agent)).resolves.toBeUndefined();
  });

  it('sends a typed turn once, stores its answer, and keeps logs free of text', async () => {
    const t = setup((adapter) => {
      adapter.events = [
        event('run.started', {}),
        event('text.delta', { message_id: 'reply', delta: 'full reply' }),
        event('done', { status: 'completed' }),
      ];
    });
    const clientId = randomUUID();
    const first = await send(t.service, agent, 'private user text', clientId);
    expect(first.message.kind === 'user_text' && first.message.status).toBe('sent');
    const repeat = await send(t.service, agent, 'different private text', clientId);
    expect(repeat.created).toBe(false);
    expect(repeat.message.id).toBe(first.message.id);
    await until(() => t.adapters.length === 1 && t.adapters[0]!.turns.length === 1);
    const adapter = t.adapters[0]!;
    expect(adapter.turns[0]).toMatchObject({
      surface: 'text',
      sessionId: agent,
      text: 'private user text',
    });
    expect(JSON.stringify(t.logs)).not.toContain('private user text');
    expect(JSON.stringify(t.logs)).not.toContain('different private text');
    expect(
      t.frames.every(
        (frame) =>
          frame.type === 'message.upserted' ||
          frame.type === 'turn.progress' ||
          frame.type === 'thread.cleared',
      ),
    ).toBe(true);
    await until(async () =>
      (await messages(t.store)).some(
        (row) => row.kind === 'user_text' && row.status === 'answered',
      ),
    );
    expect((await messages(t.store)).find((row) => row.kind === 'agent_text')).toMatchObject({
      text: 'full reply',
      partial: false,
    });
    expect(
      t.frames.some(
        (frame) =>
          frame.type === 'message.upserted' &&
          frame.message.kind === 'user_text' &&
          frame.message.status === 'working',
      ),
    ).toBe(true);
  });

  it('queues offline and during a live call, then starts on a sweep', async () => {
    const t = setup();
    t.setOnline(false);
    const offline = await send(t.service);
    expect(offline.message.kind === 'user_text' && offline.message.status).toBe('queued');
    expect(t.adapters).toHaveLength(0);
    t.setOnline(true);
    await t.service.sweep();
    await until(() => t.adapters.length === 1);
    await until(async () =>
      (await messages(t.store)).some((row) => row.kind === 'user_text' && row.status === 'failed'),
    );
    t.setCall(true);
    const held = await send(t.service, other);
    expect(held.message.kind === 'user_text' && held.message.status).toBe('queued');
    t.setCall(false);
    await t.service.sweep();
    await until(() => t.adapters.length === 2);
  });

  it('stops a running turn and a queued turn without sending the queued one', async () => {
    const t = setup((adapter) => {
      adapter.held = true;
      adapter.events = [event('text.delta', { message_id: 'reply', delta: 'partial reply' })];
    });
    const first = await send(t.service);
    await until(() => t.adapters.length === 1 && t.adapters[0]!.turns.length === 1);
    await until(() =>
      t.frames.some((frame) => frame.type === 'turn.progress' && frame.text === 'partial reply'),
    );
    const second = await send(t.service);
    expect(second.message.kind === 'user_text' && second.message.status).toBe('queued');
    const stoppedQueued = await t.service.stop('owner', second.message.id);
    expect(stoppedQueued?.kind === 'user_text' && stoppedQueued.status).toBe('stopped');
    const stopped = await t.service.stop('owner', first.message.id);
    expect(stopped?.kind === 'user_text' && stopped.status).toBe('stopped');
    await until(() => t.adapters[0]!.cancellations.length > 0);
    expect(t.adapters[0]!.cancellations[0]?.[1]).toBe('superseded');
    expect(t.adapters).toHaveLength(1);
    await until(async () => (await messages(t.store)).some((row) => row.kind === 'agent_text'));
    expect((await messages(t.store)).find((row) => row.kind === 'agent_text')).toMatchObject({
      text: 'partial reply',
      partial: true,
    });
  });

  it('times out an empty event stream and cancels it', async () => {
    const t = setup((adapter) => {
      adapter.held = true;
    });
    await send(t.service);
    await until(() => t.adapters.length === 1);
    await until(() => t.adapters[0]!.cancellations.some(([, reason]) => reason === 'timeout'));
    const row = (await messages(t.store)).find((m) => m.kind === 'user_text');
    expect(row).toMatchObject({ status: 'failed', error_code: 'agent_timeout' });
  });

  it('requeues an offline connect failure and fails other connect errors', async () => {
    let count = 0;
    const t = setup((adapter) => {
      adapter.connectError = new AdapterError(count++ === 0 ? 'agent_offline' : 'auth_failed');
    });
    const first = await send(t.service);
    await until(async () =>
      (await messages(t.store)).some(
        (row) => row.id === first.message.id && row.kind === 'user_text' && row.status === 'queued',
      ),
    );
    expect(t.adapters).toHaveLength(1);
    await t.service.sweep();
    await until(async () =>
      (await messages(t.store)).some(
        (row) => row.id === first.message.id && row.kind === 'user_text' && row.status === 'failed',
      ),
    );
    expect((await messages(t.store)).find((row) => row.id === first.message.id)).toMatchObject({
      error_code: 'auth_failed',
    });
    expect(t.adapters.every((adapter) => adapter.turns.length === 0)).toBe(true);
  });

  it('keeps an error reply partial, denies approval, and throttles progress', async () => {
    const t = setup((adapter) => {
      adapter.events = [
        event('run.started', {}),
        event('approval.required', { approval_id: 'approve-1', action: 'other', title: 'Do this' }),
        ...Array.from({ length: 20 }, (_, i) =>
          event('text.delta', { message_id: 'reply', delta: String(i % 10) }),
        ),
        event('activity', { label: '  Checking\ncalendar  ' }),
        event('error', { code: 'agent_error' }),
        event('done', { status: 'failed' }),
      ];
    });
    await send(t.service);
    await until(async () =>
      (await messages(t.store)).some((row) => row.kind === 'user_text' && row.status === 'failed'),
    );
    expect(t.adapters[0]!.approvals[0]).toMatchObject([expect.any(String), 'approve-1', 'deny']);
    expect((await messages(t.store)).find((row) => row.kind === 'agent_text')).toMatchObject({
      text: '01234567890123456789',
      partial: true,
    });
    expect((await messages(t.store)).find((row) => row.kind === 'user_text')).toMatchObject({
      error_code: 'agent_error',
    });
    const progress = t.frames.filter((frame) => frame.type === 'turn.progress');
    expect(progress.length).toBeLessThanOrEqual(2);
    expect(progress.at(-1)).toMatchObject({
      text: '01234567890123456789',
      activity: 'Checking calendar',
    });
  });

  it('runs different agents in parallel and sends queued work after the first turn', async () => {
    let created = 0;
    const t = setup((adapter) => {
      adapter.held = created++ < 2;
    });
    await send(t.service);
    await until(() => t.adapters.length === 1 && t.adapters[0]!.turns.length === 1);
    const second = await send(t.service);
    expect(second.message).toMatchObject({ status: 'queued' });
    await send(t.service, other);
    await until(() => t.adapters.length === 2 && t.adapters[1]!.turns.length === 1);
    expect(t.adapters[0]!.turns).toHaveLength(1);
    t.adapters[0]!.gate.resolve();
    await until(() => t.adapters.length === 3);
    expect(t.adapters[2]!.turns).toHaveLength(1);
  });

  it('serializes simultaneous sends for one agent', async () => {
    const t = setup((adapter) => {
      adapter.held = true;
    });
    const [first, second] = await Promise.all([send(t.service), send(t.service)]);
    expect(first.message).toMatchObject({ status: 'sent' });
    expect(second.message).toMatchObject({ status: 'queued' });
    await until(() => t.adapters.length === 1 && t.adapters[0]!.turns.length === 1);
    expect(t.adapters).toHaveLength(1);
  });

  it('drops all user data when deletion aborts active work', async () => {
    const t = setup((adapter) => {
      adapter.held = true;
    });
    await send(t.service);
    await until(() => t.adapters.length === 1 && t.adapters[0]!.turns.length === 1);
    expect(await t.service.deleteAllForUser('owner')).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await messages(t.store)).toEqual([]);
    expect(t.adapters[0]!.cancellations[0]?.[1]).toBe('superseded');
  });

  it('deletes one agent thread and keeps another', async () => {
    const t = setup((adapter) => {
      adapter.held = true;
    });
    await send(t.service);
    await until(() => t.adapters.length === 1 && t.adapters[0]!.turns.length === 1);
    t.setOnline(false);
    await send(t.service, other);
    expect(await t.service.deleteAgent('owner', agent)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await messages(t.store)).toEqual([]);
    expect(await messages(t.store, other)).toHaveLength(1);
  });

  it('marks in-flight messages interrupted at start', async () => {
    const t = setup();
    const preexisting = await t.store.appendUserMessage('owner', agent, {
      clientId: randomUUID(),
      text: 'preexisting',
      status: 'working',
    });
    await t.service.start();
    expect(
      (await messages(t.store)).find((row) => row.id === preexisting.message.id),
    ).toMatchObject({ status: 'interrupted' });
    t.service.stop();
  });

  it('deletes running data without a late write', async () => {
    const t = setup((adapter) => {
      adapter.held = true;
    });
    await send(t.service);
    await until(() => t.adapters.length === 1 && t.adapters[0]!.turns.length === 1);
    expect(await t.service.clear('owner', agent)).toBe(1);
    await until(() => t.adapters[0]!.cancellations.length > 0);
    expect(await messages(t.store)).toEqual([]);
    expect(t.frames.at(-1)).toEqual({ type: 'thread.cleared', agent_id: agent });
  });
});
