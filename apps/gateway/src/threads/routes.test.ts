/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';

import type { TwringAgentAdapter } from '@twring/agent-adapter';
import { loadGatewayEnv } from '@twring/config/gateway';
import type { UserTurn } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import { startConnectorGateway, TEST_KEYS, type ConnectorGateway } from '../connectors/harness';
import { CredentialCipher, messageKeys } from '../store/cipher';
import { createMemoryStores } from '../store/repositories';
import { ThreadService, ThreadServiceError } from './service';
import { SqliteThreadStore } from './store';
import Fastify from 'fastify';

import { StoreCorruptError } from '../store/collection';
import {
  createPrerecordedTranscriber,
  PrerecordedTranscriptionError,
} from '../voice/deepgram-prerecorded';
import {
  SpeechKeyUnreadableError,
  createSpeechResolver,
  type SpeechResolver,
} from '../voice/speech-resolver';
import { ownDeepgramKeyOnly } from '../voice/server-xai-voice';
import { createXaiTranscriber } from '../voice/xai-rest';
import { registerThreadRoutes } from './routes';

const active: ConnectorGateway[] = [];
afterEach(async () => {
  for (const gateway of active.splice(0)) await gateway.close();
});
async function setup(limits: { writeRatePerMinute?: number; messagesPerDay?: number } = {}) {
  const gateway = await startConnectorGateway({ threads: { sweepIntervalMs: 20, ...limits } });
  active.push(gateway);
  const { connectorId } = await gateway.pair('alice');
  const agentId = await gateway.createAgent('alice', connectorId);
  const path = `/v1/agents/${agentId}`;
  const send = (id = randomUUID(), user = 'alice') =>
    gateway.send('POST', `${path}/messages`, { user, body: { client_id: id, text: 'Hello' } });
  return { gateway, agentId, path, send };
}

describe('phone thread routes', () => {
  it('mounts with buildApp and sends one turn through a fake adapter', async () => {
    const stores = createMemoryStores(TEST_KEYS);
    const store = new SqliteThreadStore(':memory:', new CredentialCipher(messageKeys(TEST_KEYS)));
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
      store,
      agents: stores.agents,
      agentFactory: () => () => Promise.resolve(adapter),
      agentStatus: () => 'online',
      hasLiveCallToAgent: () => false,
      notify: () => undefined,
    });
    await service.start();
    const transcribeVoiceNote = vi.fn().mockResolvedValue('hello from voice');
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      userFor: () => 'alice',
      agents: { stores, policy: { env: 'development' }, writeRatePerMinute: 100 },
      threads: {
        service,
        store,
        writeRatePerMinute: 30,
        readRatePerMinute: 120,
        messagesPerDay: 500,
        transcribeVoiceNote,
        wordsFor: (user: string, agent: string) =>
          Promise.resolve(user === 'alice' && agent === agentId ? ['Gowri', 'Lightsail'] : []),
      },
    });
    try {
      const clientId = randomUUID();
      const url = `/v1/agents/${agentId}/messages`;
      expect(
        (await app.inject({ method: 'POST', url, payload: { client_id: clientId, text: 'hi' } }))
          .statusCode,
      ).toBe(201);
      expect(
        (await app.inject({ method: 'POST', url, payload: { client_id: clientId, text: 'hi' } }))
          .statusCode,
      ).toBe(200);
      const until = Date.now() + 1000;
      while (turns.length === 0 && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(turns).toHaveLength(1);
      expect(turns[0]?.surface).toBe('text');
      const voiceId = randomUUID();
      const voiceUrl = `/v1/agents/${agentId}/voice-notes?client_id=${voiceId}&duration_ms=7000`;
      const voiceRequest = () =>
        app.inject({
          method: 'POST',
          url: voiceUrl,
          headers: { 'content-type': 'audio/mp4' },
          payload: Buffer.from([1, 2, 3]),
        });
      const voiceCreated = await voiceRequest();
      expect(voiceCreated.statusCode).toBe(201);
      expect(voiceCreated.json().message).toMatchObject({
        kind: 'user_text',
        text: 'hello from voice',
        voice: { duration_s: 7 },
      });
      expect((await voiceRequest()).statusCode).toBe(200);
      expect(transcribeVoiceNote).toHaveBeenCalledTimes(1);
      // The agent's words (owner's and agent-added) help the voice note too.
      expect(transcribeVoiceNote.mock.calls[0]?.[3]).toEqual(['Gowri', 'Lightsail']);
      const voiceUntil = Date.now() + 1000;
      while (turns.length < 2 && Date.now() < voiceUntil)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(turns[0]?.text).toBe('hi');
      expect(turns[1]?.text).toBe(
        '[Voice note, transcribed: some words may be wrong]\nhello from voice',
      );
      expect([400, 415]).toContain(
        (
          await app.inject({
            method: 'POST',
            url: voiceUrl.replace(voiceId, randomUUID()),
            headers: { 'content-type': 'text/plain' },
            payload: 'audio',
          })
        ).statusCode,
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: voiceUrl.replace(voiceId, randomUUID()),
            headers: { 'content-type': 'audio/mp4' },
            payload: Buffer.alloc(2 * 1024 * 1024 + 1),
          })
        ).statusCode,
      ).toBe(413);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: voiceUrl.replace('7000', '999'),
            headers: { 'content-type': 'audio/mp4' },
            payload: Buffer.from([1]),
          })
        ).statusCode,
      ).toBe(400);
      transcribeVoiceNote.mockResolvedValueOnce('');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: voiceUrl.replace(voiceId, randomUUID()),
            headers: { 'content-type': 'audio/mp4' },
            payload: Buffer.from([1]),
          })
        ).statusCode,
      ).toBe(400);
      transcribeVoiceNote.mockRejectedValueOnce(
        new PrerecordedTranscriptionError('provider_failure'),
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: voiceUrl.replace(voiceId, randomUUID()),
            headers: { 'content-type': 'audio/mp4' },
            payload: Buffer.from([1]),
          })
        ).statusCode,
      ).toBe(502);
      const approval = await store.appendMessage('alice', agentId, {
        kind: 'approval',
        approval_id: 'apr-1',
        title: 'Run report',
        status: 'pending',
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      if (approval.kind !== 'approval') throw new Error('missing approval');
      const decisionUrl = `/v1/agents/${agentId}/approvals/${approval.id}`;
      expect(
        (await app.inject({ method: 'POST', url: decisionUrl, payload: { decision: 'later' } }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/agents/${agentId}/approvals/msg_${'b'.repeat(20)}`,
            payload: { decision: 'deny' },
          })
        ).statusCode,
      ).toBe(404);
      const decide = vi
        .spyOn(service, 'decideApproval')
        .mockResolvedValue({ ...approval, status: 'allowed' });
      const ok = await app.inject({
        method: 'POST',
        url: decisionUrl,
        payload: { decision: 'approve' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().message.status).toBe('allowed');
      decide.mockRejectedValue(
        new ThreadServiceError('approval_conflict', { ...approval, status: 'allowed' }),
      );
      const conflict = await app.inject({
        method: 'POST',
        url: decisionUrl,
        payload: { decision: 'deny' },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().message.status).toBe('allowed');
    } finally {
      service.stop();
      await app.close();
      await store.close();
    }
  });

  it('starts only one turn for a repeated client id', async () => {
    const gateway = await startConnectorGateway({ threads: { sweepIntervalMs: 20 } });
    active.push(gateway);
    const { connectorId, connector } = await gateway.connect('alice');
    const agentId = await gateway.createAgent('alice', connectorId);
    const url = `/v1/agents/${agentId}/messages`;
    const clientId = randomUUID();
    const body = { client_id: clientId, text: 'hello' };
    expect((await gateway.send('POST', url, { user: 'alice', body })).statusCode).toBe(201);
    expect((await gateway.send('POST', url, { user: 'alice', body })).statusCode).toBe(200);
    const until = Date.now() + 3000;
    while (
      connector.received.filter((item) => item.message.type === 'user.turn').length === 0 &&
      Date.now() < until
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connector.received.filter((item) => item.message.type === 'user.turn')).toHaveLength(1);
    while (Date.now() < until) {
      const page = (await gateway.send('GET', url, { user: 'alice' })).json();
      if (page.messages.some((message: { status?: string }) => message.status === 'answered'))
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  it('sends, pages, reads, stops and clears owner messages', async () => {
    const { gateway, path, send } = await setup();
    const id = randomUUID();
    const first = await send(id);
    expect(first.statusCode).toBe(201);
    const message = first.json().message;
    expect(message.status).toBe('queued');
    const again = await send(id);
    expect(again.statusCode).toBe(200);
    expect(again.json().message.id).toBe(message.id);
    expect(
      (await gateway.send('GET', '/v1/threads', { user: 'alice' })).json().threads,
    ).toHaveLength(1);
    expect(
      (await gateway.send('GET', `${path}/messages?limit=1`, { user: 'alice' })).json().messages,
    ).toHaveLength(1);
    expect(
      (await gateway.send('PUT', `${path}/read`, { user: 'alice', body: { seq: 1 } })).statusCode,
    ).toBe(204);
    expect(
      (await gateway.send('POST', `${path}/messages/${message.id}/stop`, { user: 'alice' })).json()
        .message.status,
    ).toBe('stopped');
    expect(
      (await gateway.send('GET', `${path}/messages?after_rev=1`, { user: 'alice' })).json()
        .messages,
    ).toHaveLength(1);
    expect(
      (await gateway.send('GET', `${path}/messages?before_seq=1`, { user: 'alice' })).json()
        .messages,
    ).toHaveLength(0);
    expect((await gateway.send('DELETE', `${path}/messages`, { user: 'alice' })).json()).toEqual({
      deleted: 1,
    });
  });

  it('hides other users agents and messages and rejects invalid input', async () => {
    const { gateway, path, send } = await setup();
    const first = await send();
    const id = first.json().message.id;
    expect((await gateway.send('GET', `${path}/messages`, { user: 'bob' })).statusCode).toBe(404);
    expect(
      (
        await gateway.send(
          'POST',
          `${path}/voice-notes?client_id=${randomUUID()}&duration_ms=1000`,
          { user: 'bob' },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await gateway.send('POST', `${path}/messages/${id}/stop`, { user: 'bob' })).statusCode,
    ).toBe(404);
    expect(
      (await gateway.send('GET', '/v1/agents/bad/messages', { user: 'alice' })).statusCode,
    ).toBe(404);
    expect(
      (
        await gateway.send('GET', `${path}/messages?before_seq=1&after_rev=1`, { user: 'alice' })
      ).json().error.code,
    ).toBe('bad_request');
    expect(
      (await gateway.send('GET', `${path}/messages?limit=101`, { user: 'alice' })).statusCode,
    ).toBe(400);
    expect(
      (
        await gateway.send('POST', `${path}/messages`, {
          user: 'alice',
          body: { client_id: 'bad', text: '' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await gateway.send('PUT', `${path}/read`, { user: 'alice', body: { seq: -1 } })).statusCode,
    ).toBe(400);
    const otherPair = await gateway.pair('alice');
    // Another computer by name too: a same-named one would take over the first contact (re-link).
    const other = await gateway.stores.connectors.get('alice', otherPair.connectorId);
    await gateway.stores.connectors.touch(otherPair.connectorId, other!.agents, new Date(), 'Desk');
    const otherAgent = await gateway.createAgent('alice', otherPair.connectorId);
    expect(
      (
        await gateway.send('POST', `/v1/agents/${otherAgent}/messages/${id}/stop`, {
          user: 'alice',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await gateway.send('GET', `${path}/messages`, { user: 'alice' })).json().messages[0].status,
    ).toBe('queued');
    expect(
      (
        await gateway.send('POST', `${path}/messages`, {
          user: 'alice',
          body: { client_id: randomUUID(), text: 'x'.repeat(17000) },
        })
      ).json().error.code,
    ).toBe('bad_request');
  });

  it('enforces queue, minute and daily limits while repeats are free', async () => {
    const { send } = await setup();
    const firstId = randomUUID();
    await send(firstId);
    for (let i = 0; i < 4; i++) expect((await send()).statusCode).toBe(201);
    expect((await send()).json().error.code).toBe('thread_queue_full');
    expect((await send(firstId)).statusCode).toBe(200);
    const minute = await startConnectorGateway({ threads: { writeRatePerMinute: 30 } });
    active.push(minute);
    const paired = await minute.pair('alice');
    const agent = await minute.createAgent('alice', paired.connectorId);
    for (let i = 0; i < 30; i++)
      expect(
        (await minute.send('PUT', `/v1/agents/${agent}/read`, { user: 'alice', body: { seq: i } }))
          .statusCode,
      ).toBe(204);
    expect(
      (await minute.send('PUT', `/v1/agents/${agent}/read`, { user: 'alice', body: { seq: 31 } }))
        .statusCode,
    ).toBe(429);
    const daily = await startConnectorGateway({ threads: { messagesPerDay: 1 } });
    active.push(daily);
    const dailyPair = await daily.pair('alice');
    const dailyAgent = await daily.createAgent('alice', dailyPair.connectorId);
    const url = `/v1/agents/${dailyAgent}/messages`;
    const duplicate = { client_id: randomUUID(), text: 'one' };
    const repeated = await Promise.all([
      daily.send('POST', url, { user: 'alice', body: duplicate }),
      daily.send('POST', url, { user: 'alice', body: duplicate }),
    ]);
    expect(repeated.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(
      (
        await daily.send('POST', url, {
          user: 'alice',
          body: { client_id: randomUUID(), text: 'two' },
        })
      ).statusCode,
    ).toBe(429);
  });

  it('deletes threads with agents and with all my data', async () => {
    const { gateway, agentId, send } = await setup();
    await send();
    expect(
      (await gateway.send('DELETE', `/v1/agents/${agentId}`, { user: 'alice' })).statusCode,
    ).toBe(204);
    expect((await gateway.send('GET', '/v1/threads', { user: 'alice' })).json().threads).toEqual(
      [],
    );
    const pair = await gateway.pair('alice');
    const next = await gateway.createAgent('alice', pair.connectorId);
    await gateway.send('POST', `/v1/agents/${next}/messages`, {
      user: 'alice',
      body: { client_id: randomUUID(), text: 'hi' },
    });
    expect(
      (await gateway.send('DELETE', '/v1/me/data', { user: 'alice' })).json().deleted.messages,
    ).toBe(1);
    expect((await gateway.send('GET', '/v1/threads', { user: 'alice' })).json().threads).toEqual(
      [],
    );
  });

  it('does not mount thread routes without the option', async () => {
    const gateway = await startConnectorGateway();
    active.push(gateway);
    expect((await gateway.send('GET', '/v1/threads', { user: 'alice' })).statusCode).toBe(404);
  });
});

describe('voice notes with a person’s own Deepgram key', () => {
  const agentId = `agt_${'c'.repeat(20)}`;
  const answer = (transcript: string) =>
    new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript }] }] } }), {
      status: 200,
    });
  async function voiceApp(options: {
    fetcher: typeof fetch;
    speech?: SpeechResolver;
    messagesPerDay?: number;
    /** A self-hosted server with no Deepgram key: Deepgram notes only on the person's own key. */
    noDeepgram?: boolean;
  }) {
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: 'debug', stream: { write: (line: string) => lines.push(line) } },
    });
    const send = vi.fn(
      (_user: string, _agent: string, input: { clientId: string; text: string }) => {
        const now = new Date().toISOString();
        return Promise.resolve({
          created: true,
          message: {
            id: `msg_${'d'.repeat(20)}`,
            agent_id: agentId,
            seq: 1,
            rev: 1,
            kind: 'user_text',
            status: 'sent',
            client_id: input.clientId,
            text: input.text,
            created_at: now,
            updated_at: now,
          },
        });
      },
    );
    const onError = vi.fn();
    registerThreadRoutes(app, {
      service: { send } as unknown as ThreadService,
      store: {
        findUserMessageByClientId: () => Promise.resolve(undefined),
      } as unknown as SqliteThreadStore,
      agents: { get: () => Promise.resolve({ id: agentId } as never) },
      writeRatePerMinute: 100,
      readRatePerMinute: 100,
      messagesPerDay: options.messagesPerDay ?? 100,
      userFor: () => 'alice',
      transcribeVoiceNote: options.noDeepgram
        ? ownDeepgramKeyOnly(createPrerecordedTranscriber('', options.fetcher, 0))
        : createPrerecordedTranscriber('server-dg-key', options.fetcher, 0),
      transcribeWithXai: createXaiTranscriber(options.fetcher, 0),
      wordsFor: () => Promise.resolve(['Gowri']),
      ...(options.speech && { speech: options.speech }),
      onError,
    });
    await app.ready();
    const post = () =>
      app.inject({
        method: 'POST',
        url: `/v1/agents/${agentId}/voice-notes?client_id=${randomUUID()}&duration_ms=3000`,
        headers: { 'content-type': 'audio/mp4' },
        payload: Buffer.from([1, 2, 3]),
      });
    return { app, post, send, lines, onError };
  }
  const own: SpeechResolver = {
    resolve: () => Promise.resolve({ deepgram: { apiKey: 'own-dg-secret', source: 'own' } }),
  };
  const twring: SpeechResolver = {
    resolve: () => Promise.resolve({ deepgram: { apiKey: 'server-dg-key', source: 'twring' } }),
  };

  it('transcribes with the person’s own key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer('hello'));
    const { app, post } = await voiceApp({ fetcher, speech: own });
    expect((await post()).statusCode).toBe(201);
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: 'Token own-dg-secret',
    });
    await app.close();
  });

  it.each([401, 402, 403])(
    'a refused own key (%i) stores nothing, asks once, and gives back the daily note',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('{}', { status }))
        .mockResolvedValue(answer('hello'));
      const { app, post, send, lines } = await voiceApp({
        fetcher,
        speech: own,
        messagesPerDay: 1,
      });
      const refused = await post();
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatchObject({
        code: 'speech_key_refused',
        message: 'Your Deepgram key was refused. Update it in Settings.',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      // The daily note was rolled back: the one allowed note still goes through.
      expect((await post()).statusCode).toBe(201);
      expect(lines.join('\n')).not.toContain('own-dg-secret');
      await app.close();
    },
  );

  it('a refused Twring key keeps today’s 502', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    const { app, post } = await voiceApp({ fetcher, speech: twring });
    expect((await post()).statusCode).toBe(502);
    await app.close();
  });

  it('an unreadable saved key and an unreadable store each stop the note', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer('hello'));
    const unreadable = await voiceApp({
      fetcher,
      speech: { resolve: () => Promise.reject(new SpeechKeyUnreadableError('deepgram')) },
    });
    const res = await unreadable.post();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'speech_key_unreadable',
      message: "Couldn't read your saved Deepgram key. Add it again in Settings.",
    });
    await unreadable.app.close();
    const corrupt = await voiceApp({
      fetcher,
      speech: { resolve: () => Promise.reject(new StoreCorruptError('speech-keys.json')) },
    });
    const down = await corrupt.post();
    expect(down.statusCode).toBe(503);
    expect(down.json().error.message).toBe('Voice is briefly unavailable. Try again in a moment.');
    expect(corrupt.onError).toHaveBeenCalledTimes(1);
    expect(corrupt.lines.some((line) => line.includes('speech_keys_unavailable'))).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    await corrupt.app.close();
  });

  describe('on a self-hosted server with only its own xAI key', () => {
    const serverXai = createSpeechResolver({ enabled: false, xai: { apiKey: 'server-xai-key' } });

    it('transcribes with the server xAI key', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: 'hello' }));
      const { app, post, send } = await voiceApp({ fetcher, speech: serverXai, noDeepgram: true });
      expect((await post()).statusCode).toBe(201);
      expect(fetcher.mock.calls[0]![0] as string).toBe('https://api.x.ai/v1/stt');
      expect(fetcher.mock.calls[0]![1]!.headers).toMatchObject({
        Authorization: 'Bearer server-xai-key',
      });
      expect(send.mock.calls[0]![2]).toMatchObject({ text: 'hello' });
      await app.close();
    });

    it('a refused server key is not blamed on the person', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
      const { app, post } = await voiceApp({ fetcher, speech: serverXai, noDeepgram: true });
      const res = await post();
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).not.toBe('speech_key_refused');
      await app.close();
    });

    it('the person’s own Deepgram key still hears their note', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer('hello'));
      const speech: SpeechResolver = {
        resolve: () =>
          Promise.resolve({
            deepgram: { apiKey: 'own-dg-secret', source: 'own' },
            xai: { apiKey: 'server-xai-key', source: 'twring' },
            listening: 'deepgram',
          }),
      };
      const { app, post } = await voiceApp({ fetcher, speech, noDeepgram: true });
      expect((await post()).statusCode).toBe(201);
      expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({
        Authorization: 'Token own-dg-secret',
      });
      await app.close();
    });
  });

  const xaiListening: SpeechResolver = {
    resolve: () =>
      Promise.resolve({
        deepgram: { apiKey: 'server-dg-key', source: 'twring' },
        xai: { apiKey: 'own-xai-secret', source: 'own' },
        listening: 'xai',
      }),
  };

  it('on xAI listening sends the m4a to xAI /v1/stt with the agent words', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: 'hello' }));
    const { app, post, send } = await voiceApp({ fetcher, speech: xaiListening });
    expect((await post()).statusCode).toBe(201);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0] as string).toBe('https://api.x.ai/v1/stt');
    const init = fetcher.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ Authorization: 'Bearer own-xai-secret' });
    const form = init.body as FormData;
    expect(form.getAll('keyterm')).toEqual(['Gowri']);
    expect((form.get('file') as File).name).toBe('audio.m4a');
    expect(send.mock.calls[0]![2]).toMatchObject({ text: 'hello' });
    await app.close();
  });

  it('with an xAI key but Deepgram listening still uses Deepgram', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer('hello'));
    const { app, post } = await voiceApp({
      fetcher,
      speech: {
        resolve: () =>
          Promise.resolve({
            deepgram: { apiKey: 'server-dg-key', source: 'twring' },
            xai: { apiKey: 'own-xai-secret', source: 'own' },
            listening: 'deepgram',
          }),
      },
    });
    expect((await post()).statusCode).toBe(201);
    expect(fetcher.mock.calls[0]![0] as string).toContain('api.deepgram.com');
    await app.close();
  });

  it.each([401, 402, 403])(
    'a refused xAI key (%i) stores nothing, asks once, and gives back the daily note',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('{}', { status }))
        .mockResolvedValue(Response.json({ text: 'hello' }));
      const { app, post, send, lines } = await voiceApp({
        fetcher,
        speech: xaiListening,
        messagesPerDay: 1,
      });
      const refused = await post();
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatchObject({
        code: 'speech_key_refused',
        message: 'Your xAI key was refused. Update it in Settings.',
      });
      expect(refused.body).not.toContain('own-xai-secret');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      expect((await post()).statusCode).toBe(201);
      expect(lines.join('\n')).not.toContain('own-xai-secret');
      await app.close();
    },
  );

  it('an xAI provider failure gives 502 and never moves to Deepgram', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 500 }));
    const { app, post, send } = await voiceApp({ fetcher, speech: xaiListening });
    expect((await post()).statusCode).toBe(502);
    expect(fetcher.mock.calls.every(([url]) => (url as string) === 'https://api.x.ai/v1/stt')).toBe(
      true,
    );
    expect(send).not.toHaveBeenCalled();
    await app.close();
  });

  it('without a resolver (switch off) uses the server key as today', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer('hello'));
    const { app, post } = await voiceApp({ fetcher });
    expect((await post()).statusCode).toBe(201);
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: 'Token server-dg-key',
    });
    await app.close();
  });
});

describe('voice notes: one send per client id with a slow key lookup', () => {
  it('two concurrent posts with the same client_id reach the provider and the thread once', async () => {
    const agentId = `agt_${'e'.repeat(20)}`;
    const app = Fastify();
    const send = vi.fn((_u: string, _a: string, input: { clientId: string; text: string }) => {
      const now = new Date().toISOString();
      return Promise.resolve({
        created: true,
        message: {
          id: `msg_${'f'.repeat(20)}`,
          agent_id: agentId,
          seq: 1,
          rev: 1,
          kind: 'user_text' as const,
          status: 'sent' as const,
          client_id: input.clientId,
          text: input.text,
          created_at: now,
          updated_at: now,
        },
      });
    });
    const transcribe = vi.fn(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('hello'), 30)),
    );
    registerThreadRoutes(app, {
      service: { send } as unknown as ThreadService,
      store: {
        findUserMessageByClientId: () => Promise.resolve(undefined),
      } as unknown as SqliteThreadStore,
      agents: { get: () => Promise.resolve({ id: agentId } as never) },
      writeRatePerMinute: 100,
      readRatePerMinute: 100,
      messagesPerDay: 100,
      userFor: () => 'alice',
      transcribeVoiceNote: transcribe,
      speech: {
        resolve: () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ deepgram: { apiKey: 'own-dg', source: 'own' as const } }),
              5,
            ),
          ),
      },
    });
    const url = `/v1/agents/${agentId}/voice-notes?client_id=${randomUUID()}&duration_ms=3000`;
    const post = () =>
      app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'audio/mp4' },
        payload: Buffer.from([1, 2, 3]),
      });
    const codes = (await Promise.all([post(), post()])).map((res) => res.statusCode).sort();
    expect(codes).toEqual([200, 201]);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
