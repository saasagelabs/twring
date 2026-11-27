import { randomBytes, randomUUID } from 'node:crypto';

import type { TwringAgentAdapter } from '@twring/agent-adapter';
import type { AgentEvent, UserTurn } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRecord } from '../store/repositories';
import { CredentialCipher, messageKeys } from '../store/cipher';
import { SqliteThreadStore } from './store';
import { THREAD_TURN_TIMEOUTS, ThreadService } from './service';

const agent = `agt_${'s'.repeat(20)}`;
const MINUTE = 60_000;

class HeldAdapter {
  readonly name = 'held';
  readonly capabilities = {
    streamingText: true,
    cancellation: true,
    resumableStream: false,
    activityEvents: true,
    toolEvents: true,
    approvals: false,
    conversationResume: true,
    serverInitiatedCalls: false,
  };
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  connect(): Promise<void> {
    return Promise.resolve();
  }
  async *sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: 'run.started', event_id: randomUUID(), turn_id: turn.turnId };
    yield {
      type: 'text.delta',
      event_id: randomUUID(),
      turn_id: turn.turnId,
      message_id: 'reply',
      delta: 'partial',
    };
    await Promise.race([
      this.released,
      new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())),
    ]);
  }
  cancelTurn(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.release();
    return Promise.resolve();
  }
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run();
});

function setup(protocol: AgentRecord['protocol'] = 'cord-rest') {
  let clock = Date.now();
  const store = new SqliteThreadStore(
    ':memory:',
    new CredentialCipher(
      messageKeys({ currentVersion: 1, keys: new Map([[1, randomBytes(32).toString('base64')]]) }),
    ),
    () => new Date(clock),
  );
  const adapters: HeldAdapter[] = [];
  const logs: [Record<string, unknown>, string][] = [];
  const service = new ThreadService({
    store,
    agents: {
      get: (userId, id) =>
        Promise.resolve(
          userId === 'owner'
            ? {
                id,
                user_id: 'owner',
                name: 'Agent',
                protocol,
                endpoint_url: 'https://example.com/agent',
                voice_id: 'flux-aura-en',
                status: 'ready',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
              }
            : undefined,
        ),
    },
    agentFactory: () => () => {
      const adapter = new HeldAdapter();
      adapters.push(adapter);
      return Promise.resolve(adapter as unknown as TwringAgentAdapter);
    },
    agentStatus: () => 'online',
    hasLiveCallToAgent: () => false,
    notify: () => undefined,
    log: {
      info: (data, msg) => logs.push([data, msg]),
      warn: (data, msg) => logs.push([data, msg]),
    },
    timeouts: { firstEventMs: 60 * MINUTE, idleMs: 60 * MINUTE, connectMs: 60 * MINUTE },
  });
  cleanup.push(async () => {
    service.stop();
    for (const adapter of adapters) await adapter.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.close();
  });
  return {
    store,
    service,
    adapters,
    logs,
    ago: (ms: number) => {
      clock = Date.now() - ms;
    },
    reset: () => {
      clock = Date.now();
    },
  };
}
const status = async (store: SqliteThreadStore, id: string) => {
  const message = await store.findMessageById('owner', agent, id);
  return message?.kind === 'user_text' ? message.status : undefined;
};
const stale = (logs: [Record<string, unknown>, string][]) =>
  logs.filter(([, msg]) => msg === 'thread_turn_stale');
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not reached');
}

describe('AI app (mcp-app) owner messages', () => {
  it('are stored answered, never launched, still read by check_replies, and survive a restart', async () => {
    const t = setup('mcp-app');
    const sent = await t.service.send('owner', agent, { clientId: randomUUID(), text: 'hello' });
    expect(sent.message.kind === 'user_text' && sent.message.status).toBe('answered');
    expect(t.adapters).toHaveLength(0);
    expect((await t.store.ownerReplies('owner', agent)).map((m) => m.text)).toEqual(['hello']);
    await t.store.interruptInFlight();
    expect(await status(t.store, sent.message.id)).toBe('answered');
  });
});

describe('stale in-flight sweep', () => {
  const cutoff = THREAD_TURN_TIMEOUTS.totalMs + 5 * MINUTE;

  it('interrupts an old working turn with no live run, once', async () => {
    const t = setup();
    t.ago(cutoff + 5 * MINUTE);
    const { message } = await t.store.appendUserMessage('owner', agent, {
      clientId: randomUUID(),
      text: 'lost',
      status: 'working',
    });
    const fresh = await t.store.appendUserMessage('owner', agent, {
      clientId: randomUUID(),
      text: 'recent',
      status: 'sent',
    });
    t.reset();
    // Touched just now (a live turn's status change): not stale.
    await t.store.updateUserMessage('owner', fresh.message.id, { status: 'sent' });
    await t.service.sweep();
    expect(await status(t.store, message.id)).toBe('interrupted');
    expect(await status(t.store, fresh.message.id)).toBe('sent');
    await t.service.sweep();
    expect(stale(t.logs)).toHaveLength(1);
    expect(stale(t.logs)[0]?.[0]).toMatchObject({
      message_id: message.id,
      agent_id: agent,
      protocol: 'cord-rest',
    });
  });

  it('leaves a live run older than the cutoff alone', async () => {
    const t = setup();
    t.ago(cutoff + MINUTE);
    const sent = await t.service.send('owner', agent, { clientId: randomUUID(), text: 'long' });
    await until(async () => (await status(t.store, sent.message.id)) === 'working');
    t.reset();
    await t.service.sweep();
    expect(await status(t.store, sent.message.id)).toBe('working');
    expect(stale(t.logs)).toHaveLength(0);
  });

  it('never touches a private chat', async () => {
    const t = setup();
    t.ago(cutoff + MINUTE);
    const { message } = await t.store.appendUserMessage('owner', agent, {
      clientId: randomUUID(),
      text: 'before private',
      status: 'working',
    });
    await t.store.setPrivate('owner', agent);
    t.reset();
    expect(await t.store.staleInFlight(new Date().toISOString())).toHaveLength(0);
    await t.service.sweep();
    expect(await status(t.store, message.id)).toBe('working');
  });

  it('keeps an answer that lands after the select (from-guard)', async () => {
    const t = setup();
    t.ago(cutoff + MINUTE);
    const { message } = await t.store.appendUserMessage('owner', agent, {
      clientId: randomUUID(),
      text: 'racing',
      status: 'working',
    });
    t.reset();
    const select = t.store.staleInFlight.bind(t.store);
    t.store.staleInFlight = async (before) => {
      const rows = await select(before);
      await t.store.updateUserMessage('owner', message.id, { status: 'answered' });
      return rows;
    };
    await t.service.sweep();
    expect(await status(t.store, message.id)).toBe('answered');
    expect(stale(t.logs)).toHaveLength(0);
  });
});
