/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';

import type { TwringAgentAdapter } from '@twring/agent-adapter';
import { loadGatewayEnv } from '@twring/config/gateway';
import type { ThreadMessage, UserTurn } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import { TEST_KEYS } from '../connectors/harness';
import { CredentialCipher, messageKeys } from '../store/cipher';
import { createMemoryStores } from '../store/repositories';
import { ThreadService } from '../threads/service';
import { registerMessageSpeechRoute } from '../threads/speech';
import { SqliteThreadStore } from '../threads/store';
import { assertNotPrivate, isPrivate, PrivateThreadError } from './guard';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const PHONE = `dev_${'p'.repeat(20)}`;
const AGENT = `agt_${'z'.repeat(20)}`;
const sealed = {
  v: 1 as const,
  sender_device: PHONE,
  sender_seq: 1,
  nonce: 'bm9uY2U',
  body: 'Y2lwaGVy',
  keys: [{ device: PHONE, wrapped: 'd3JhcA' }],
};

describe('private thread guard', () => {
  it('knows a private thread from its summary', () => {
    expect(isPrivate({ private: true })).toBe(true);
    expect(isPrivate({ private: false })).toBe(false);
    expect(isPrivate({})).toBe(false);
  });

  it('refuses a server feature on a private chat with a stable code', async () => {
    const store = { isPrivate: vi.fn((_u: string, a: string) => Promise.resolve(a === 'priv')) };
    await expect(assertNotPrivate(store, 'u1', 'open')).resolves.toBeUndefined();
    const refused = assertNotPrivate(store, 'u1', 'priv');
    await expect(refused).rejects.toBeInstanceOf(PrivateThreadError);
    await expect(refused).rejects.toMatchObject({ code: 'private_thread' });
  });
});

describe('server features skip private chats', () => {
  async function store() {
    const s = new SqliteThreadStore(':memory:', new CredentialCipher(messageKeys(TEST_KEYS)));
    closers.push(() => s.close());
    return s;
  }

  it('check_replies and twring_status read nothing from a private thread', async () => {
    const s = await store();
    await s.appendUserMessage('u1', AGENT, {
      clientId: randomUUID(),
      text: 'said before it went private',
      status: 'answered',
    });
    expect(await s.ownerReplies('u1', AGENT)).toHaveLength(1);
    await s.setPrivate('u1', AGENT);
    await s.appendSealedMessage('u1', AGENT, { author: 'user', sealed, clientId: randomUUID() });
    expect(await s.ownerReplies('u1', AGENT)).toEqual([]);
    expect(await s.ownerReplies('u1', AGENT, '2000-01-01T00:00:00.000Z')).toEqual([]);
    expect(await s.ownerReplyCount('u1', AGENT)).toBe(0);
  });

  it('Listen refuses a sealed message', async () => {
    const app = Fastify();
    closers.push(() => app.close());
    registerMessageSpeechRoute(app, {
      agents: { get: () => Promise.resolve({ voice_id: 'flux-aura-en' } as never) },
      store: {
        findMessageById: () =>
          Promise.resolve({ kind: 'sealed', author: 'agent', sealed } as unknown as ThreadMessage),
      },
      deepgram: { apiKey: 'k' },
      userFor: () => 'u1',
      fetch: vi.fn(),
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/agents/agt_${'a'.repeat(20)}/messages/msg_${'b'.repeat(20)}/speech`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('private_thread');
  });

  async function voiceApp() {
    const stores = createMemoryStores(TEST_KEYS);
    const s = await store();
    const agentId = `agt_${'a'.repeat(20)}`;
    const now = new Date().toISOString();
    await stores.agents.create({
      id: agentId,
      user_id: 'alice',
      name: 'Agent',
      protocol: 'cord-rest',
      endpoint_url: 'https://example.com/agent',
      voice_id: 'flux-aura-en',
      status: 'ready',
      created_at: now,
      updated_at: now,
    });
    const turns: UserTurn[] = [];
    const adapter: TwringAgentAdapter = {
      name: 'fake',
      capabilities: {
        streamingText: true,
        cancellation: true,
        resumableStream: false,
        activityEvents: false,
        toolEvents: false,
        approvals: false,
        conversationResume: false,
        serverInitiatedCalls: false,
      },
      connect: () => Promise.resolve(),
      async *sendTurn(turn) {
        await Promise.resolve();
        turns.push(turn);
        yield { type: 'done', event_id: randomUUID(), turn_id: turn.turnId, status: 'completed' };
      },
      close: () => Promise.resolve(),
    };
    const service = new ThreadService({
      store: s,
      agents: stores.agents,
      agentFactory: () => () => Promise.resolve(adapter),
      agentStatus: () => 'online',
      hasLiveCallToAgent: () => false,
      notify: () => undefined,
    });
    await service.start();
    closers.push(() => Promise.resolve(service.stop()));
    const transcribe = vi.fn(() => Promise.resolve('hello there'));
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      userFor: () => 'alice',
      agents: { stores, policy: { env: 'development' }, writeRatePerMinute: 100 },
      threads: {
        service,
        store: s,
        writeRatePerMinute: 30,
        readRatePerMinute: 120,
        messagesPerDay: 500,
        transcribeVoiceNote: transcribe,
      },
    });
    closers.push(() => app.close());
    await s.setPrivate('alice', agentId);
    const voice = (consent: boolean, extra = '') =>
      app.inject({
        method: 'POST',
        url: `/v1/agents/${agentId}/voice-notes?client_id=${randomUUID()}&duration_ms=5000${consent ? '&server_readable=1' : ''}${extra}`,
        headers: { 'content-type': 'audio/mp4' },
        payload: Buffer.from([1, 2, 3]),
      });
    return { app, s, agentId, voice, transcribe, turns };
  }

  it('a voice note in a private chat needs the server_readable consent', async () => {
    const { voice, transcribe } = await voiceApp();
    const refused = await voice(false);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('private_thread');
    // Refused before any audio left for transcription.
    expect(transcribe).not.toHaveBeenCalled();
    const ok = await voice(true);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().message).toMatchObject({
      kind: 'user_text',
      text: 'hello there',
      server_readable: true,
    });
  });

  it('a consented voice note may answer a sealed message, without a server quote', async () => {
    const { voice, s, agentId } = await voiceApp();
    const answered = await s.appendSealedMessage('alice', agentId, {
      author: 'agent',
      sealed,
    });
    const res = await voice(true, `&reply_to=${answered.message.id}`);
    expect(res.statusCode).toBe(201);
    expect(res.json().message.reply_to).toBe(answered.message.id);
    expect(res.json().message.quote).toBeUndefined();
  });

  it('typed text stays refused in a chat that takes consented voice notes', async () => {
    const { app, agentId } = await voiceApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agents/${agentId}/messages`,
      payload: { client_id: randomUUID(), text: 'typed' },
    });
    // The chat is private: typed text is refused, so nothing leaves in plain text.
    expect(res.statusCode).toBe(409);
  });
});
