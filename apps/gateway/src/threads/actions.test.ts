/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';

import type { TwringAgentAdapter } from '@twring/agent-adapter';
import {
  MAX_QUOTE_CHARS,
  mediaPageResponseSchema,
  threadMessageSchema,
  type ThreadSocketFrame,
  type UserTurn,
} from '@twring/contracts';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEST_KEYS } from '../connectors/harness';
import type { FileService } from '../files/service';
import { CredentialCipher, messageKeys } from '../store/cipher';
import { createMemoryStores } from '../store/repositories';
import { withQuote } from './quote';
import { registerThreadRoutes } from './routes';
import { ThreadService } from './service';
import { SqliteThreadStore } from './store';

const AGENT = `agt_${'a'.repeat(20)}`;
const OTHER_AGENT = `agt_${'b'.repeat(20)}`;
const BOB_AGENT = `agt_${'c'.repeat(20)}`;
let fileSeq = 0;
const fileId = () => `fil_${String.fromCharCode(97 + (fileSeq++ % 26)).repeat(20)}`;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  fileSeq = 0;
});

async function setup() {
  const stores = createMemoryStores(TEST_KEYS);
  let clock = Date.parse('2026-11-24T00:00:00.000Z');
  const store = new SqliteThreadStore(
    ':memory:',
    new CredentialCipher(messageKeys(TEST_KEYS)),
    () => new Date((clock += 1_000)),
  );
  const at = new Date().toISOString();
  for (const [id, user] of [
    [AGENT, 'alice'],
    [OTHER_AGENT, 'alice'],
    [BOB_AGENT, 'bob'],
  ] as const)
    await stores.agents.create({
      id,
      user_id: user,
      name: 'Agent',
      protocol: 'cord-rest',
      endpoint_url: 'https://example.com/agent',
      voice_id: 'flux-aura-en',
      status: 'ready',
      created_at: at,
      updated_at: at,
    });
  const turns: UserTurn[] = [];
  let hold: Promise<void> = Promise.resolve();
  let releaseHold = () => undefined as void;
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
      turns.push(turn);
      await hold;
      yield { type: 'done', event_id: randomUUID(), turn_id: turn.turnId, status: 'completed' };
    },
    close: () => Promise.resolve(),
  };
  const frames: { userId: string; frame: ThreadSocketFrame }[] = [];
  const deleteBlobs = vi.fn((_ids: string[]) => Promise.resolve());
  const service = new ThreadService({
    store,
    files: { deleteBlobs } as unknown as FileService,
    agents: stores.agents,
    agentFactory: () => () => Promise.resolve(adapter),
    agentStatus: () => 'online',
    hasLiveCallToAgent: () => false,
    notify: (userId, frame) => frames.push({ userId, frame }),
  });
  await service.start();
  const app = Fastify();
  const transcribeVoiceNote = vi.fn().mockResolvedValue('voice words');
  registerThreadRoutes(app, {
    service,
    store,
    agents: stores.agents,
    writeRatePerMinute: 1_000,
    readRatePerMinute: 1_000,
    messagesPerDay: 1_000,
    userFor: (request) => (request.headers['x-user'] as string | undefined) ?? 'alice',
    transcribeVoiceNote,
    filesEnabled: true,
  });
  await app.ready();
  closers.push(async () => {
    service.stop();
    await app.close();
    await store.close();
  });
  const send = async (
    body: Record<string, unknown>,
    options: { user?: string; agent?: string } = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/agents/${options.agent ?? AGENT}/messages`,
      headers: { 'x-user': options.user ?? 'alice' },
      payload: { client_id: randomUUID(), text: 'Hello', ...body },
    });
  const del = (messageId: string, user = 'alice', agent = AGENT) =>
    app.inject({
      method: 'DELETE',
      url: `/v1/agents/${agent}/messages/${messageId}`,
      headers: { 'x-user': user },
    });
  const media = (query = '', user = 'alice', agent = AGENT) =>
    app.inject({
      method: 'GET',
      url: `/v1/agents/${agent}/media${query}`,
      headers: { 'x-user': user },
    });
  /** An agent reply stored directly, as a finished turn would leave it. */
  const agentSays = async (text: string, attachmentIds?: string[], agent = AGENT, user = 'alice') =>
    (
      await store.appendMessage(user, agent, {
        kind: 'agent_text',
        text,
        partial: false,
        clientId: randomUUID(),
        ...(attachmentIds && { attachmentIds }),
      })
    ).message;
  const addFile = (direction: 'owner' | 'agent', agent = AGENT, user = 'alice') =>
    store.insertFile({
      id: fileId(),
      userId: user,
      agentId: agent,
      direction,
      clientId: null,
      mime_type: 'image/png',
      size_bytes: 10,
      name: 'photo.png',
      sha256: 'x'.repeat(64),
    }).file.id;
  const waitFor = async (check: () => boolean) => {
    const until = Date.now() + 2_000;
    while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  };
  return {
    app,
    store,
    service,
    turns,
    frames,
    deleteBlobs,
    transcribeVoiceNote,
    send,
    del,
    media,
    agentSays,
    addFile,
    waitFor,
    holdTurns: () => {
      hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
    },
    release: () => releaseHold(),
  };
}

describe('reply to one message', () => {
  it('stores reply_to and a sealed quote, and the agent reads the quote first', async () => {
    const t = await setup();
    const answered = await t.agentSays('**Bold** plan:\n\n- step one');
    const response = await t.send({ text: 'Do step one', reply_to: answered.id });
    expect(response.statusCode).toBe(201);
    const message = threadMessageSchema.parse(response.json().message);
    expect(message).toMatchObject({
      reply_to: answered.id,
      quote: { text: '**Bold** plan: - step one', from: 'agent' },
    });
    await t.waitFor(() => t.turns.length === 1);
    expect(t.turns[0]?.text).toBe(
      'Replying to your earlier message: "**Bold** plan: - step one"\n\nDo step one',
    );
    // The quote is sealed at rest like the text, never left readable in meta.
    const raw = (
      t.store as unknown as {
        db: { prepare(sql: string): { get(id: string): { meta: string } } };
      }
    ).db
      .prepare('SELECT meta FROM messages WHERE id=?')
      .get(message.id);
    expect(raw.meta).not.toContain('step one');
    const page = await t.app.inject({ method: 'GET', url: `/v1/agents/${AGENT}/messages` });
    expect(page.json().messages[0]).toMatchObject({ reply_to: answered.id });
  });

  it('quotes my own message as mine to the agent', async () => {
    const t = await setup();
    const first = await t.send({ text: 'first thought' });
    await t.waitFor(() => t.turns.length === 1);
    await t.waitFor(() => t.frames.some((f) => f.frame.type === 'message.upserted'));
    const reply = await t.send({ text: 'and more', reply_to: first.json().message.id });
    expect(reply.json().message.quote).toEqual({ text: 'first thought', from: 'owner' });
    await t.waitFor(() => t.turns.length === 2);
    expect(t.turns[1]?.text).toBe('Replying to my earlier message: "first thought"\n\nand more');
  });

  it('refuses reply_to from another user or another agent without leaking it', async () => {
    const t = await setup();
    const bobs = await t.agentSays('bob secret', undefined, BOB_AGENT, 'bob');
    const otherAgent = await t.agentSays('other agent text', undefined, OTHER_AGENT);
    for (const id of [bobs.id, otherAgent.id, `msg_${'z'.repeat(20)}`]) {
      const response = await t.send({ reply_to: id });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('reply_to_not_found');
      expect(response.body).not.toContain('secret');
    }
    expect((await t.send({ reply_to: 'not-an-id' })).statusCode).toBe(400);
    expect(t.turns).toHaveLength(0);
  });

  it('refuses reply_to on a deleted message', async () => {
    const t = await setup();
    const answered = await t.agentSays('soon gone');
    expect((await t.del(answered.id)).statusCode).toBe(204);
    const response = await t.send({ reply_to: answered.id });
    expect(response.json().error.code).toBe('reply_to_not_found');
  });

  it('cuts a long quote to the limit with an ellipsis', async () => {
    const t = await setup();
    const answered = await t.agentSays('word '.repeat(200));
    const response = await t.send({ reply_to: answered.id });
    const quote: string = response.json().message.quote.text;
    expect(quote.endsWith('…')).toBe(true);
    expect(quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS + 1);
  });

  it('a client_id replay returns the stored message with its reply_to', async () => {
    const t = await setup();
    const answered = await t.agentSays('the plan');
    const clientId = randomUUID();
    const first = await t.send({ client_id: clientId, reply_to: answered.id });
    expect(first.statusCode).toBe(201);
    // Even after the answered message is deleted, the replay is the stored message.
    expect((await t.del(answered.id)).statusCode).toBe(204);
    await t.waitFor(() => t.turns.length === 1);
    const again = await t.send({ client_id: clientId, reply_to: answered.id });
    expect(again.statusCode).toBe(200);
    expect(again.json().message).toMatchObject({
      id: first.json().message.id,
      reply_to: answered.id,
      quote: { text: 'the plan', from: 'agent' },
    });
    expect(t.turns).toHaveLength(1);
  });

  it('a voice note can reply, and a bad reply_to stops it before transcription', async () => {
    const t = await setup();
    const answered = await t.agentSays('which one?');
    const post = (replyTo: string) =>
      t.app.inject({
        method: 'POST',
        url: `/v1/agents/${AGENT}/voice-notes?client_id=${randomUUID()}&duration_ms=3000&reply_to=${replyTo}`,
        headers: { 'content-type': 'audio/mp4' },
        payload: Buffer.from([1, 2, 3]),
      });
    const bad = await post(`msg_${'z'.repeat(20)}`);
    expect(bad.json().error.code).toBe('reply_to_not_found');
    expect(t.transcribeVoiceNote).not.toHaveBeenCalled();
    const good = await post(answered.id);
    expect(good.statusCode).toBe(201);
    expect(good.json().message).toMatchObject({ reply_to: answered.id, voice: {} });
    await t.waitFor(() => t.turns.length === 1);
    expect(t.turns[0]?.text).toBe(
      '[Voice note, transcribed: some words may be wrong]\nReplying to your earlier message: "which one?"\n\nvoice words',
    );
  });

  it('withQuote leaves a message without a quote unchanged', () => {
    const message = threadMessageSchema.parse({
      id: `msg_${'a'.repeat(20)}`,
      agent_id: AGENT,
      seq: 1,
      rev: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      kind: 'user_text',
      text: 'hi',
      status: 'sent',
      client_id: randomUUID(),
    });
    if (message.kind !== 'user_text') throw new Error('kind');
    expect(withQuote(message, 'hi')).toBe('hi');
  });
});

describe('delete one message', () => {
  it('refuses while the reply is streaming, then deletes once and is idempotent', async () => {
    const t = await setup();
    t.holdTurns();
    const sent = await t.send({ text: 'long task' });
    const id: string = sent.json().message.id;
    await t.waitFor(() => t.turns.length === 1);
    const busy = await t.del(id);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('message_in_progress');
    t.release();
    await t.waitFor(() =>
      t.frames.some(
        (f) =>
          f.frame.type === 'message.upserted' &&
          f.frame.message.id === id &&
          f.frame.message.kind === 'user_text' &&
          !['sent', 'working'].includes(f.frame.message.status),
      ),
    );
    expect((await t.del(id)).statusCode).toBe(204);
    // Already deleted: still 204 (idempotent), and no second socket event.
    expect((await t.del(id)).statusCode).toBe(204);
    const deletions = t.frames.filter((f) => f.frame.type === 'message.deleted');
    expect(deletions).toEqual([
      { userId: 'alice', frame: { type: 'message.deleted', agent_id: AGENT, message_id: id } },
    ]);
  });

  it('another user cannot delete my message, and nothing is announced', async () => {
    const t = await setup();
    const mine = await t.agentSays('mine');
    expect((await t.del(mine.id, 'bob', BOB_AGENT)).statusCode).toBe(204);
    expect((await t.del(mine.id, 'bob', AGENT)).statusCode).toBe(404);
    expect(await t.store.findMessageById('alice', AGENT, mine.id)).toBeDefined();
    expect(t.frames.filter((f) => f.frame.type === 'message.deleted')).toHaveLength(0);
  });

  it("removes only that message's files", async () => {
    const t = await setup();
    const keep = t.addFile('agent');
    const drop = [t.addFile('agent'), t.addFile('agent')];
    const kept = await t.agentSays('keep', [keep]);
    const dropped = await t.agentSays('drop', drop);
    expect((await t.del(dropped.id)).statusCode).toBe(204);
    expect(t.deleteBlobs).toHaveBeenCalledWith(drop);
    expect(t.store.findFile('alice', keep)).toBeDefined();
    for (const id of drop) expect(t.store.findFile('alice', id)).toBeUndefined();
    expect(await t.store.findMessageById('alice', AGENT, kept.id)).toMatchObject({
      attachments: [{ id: keep }],
    });
  });

  it('updates the summary preview and unread count', async () => {
    const t = await setup();
    const older = await t.agentSays('older');
    const newest = await t.agentSays('newest');
    let [summary] = await t.store.listThreads('alice');
    expect(summary).toMatchObject({ unread: 2, last_message: { id: newest.id } });
    expect((await t.del(newest.id)).statusCode).toBe(204);
    [summary] = await t.store.listThreads('alice');
    expect(summary).toMatchObject({
      unread: 1,
      last_message: { id: older.id },
      last_message_at: older.created_at,
    });
    expect((await t.del(older.id)).statusCode).toBe(204);
    [summary] = await t.store.listThreads('alice');
    expect(summary).toMatchObject({ unread: 0, last_message: null, last_message_at: null });
  });
});

describe('media list', () => {
  it('pages newest first with a cursor that ends', async () => {
    const t = await setup();
    const sentFile = t.addFile('owner');
    await t.store.appendUserMessage('alice', AGENT, {
      clientId: randomUUID(),
      text: '',
      status: 'answered',
      attachmentIds: [sentFile],
    });
    const received: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = t.addFile('agent');
      received.push(id);
      await t.agentSays(`file ${i}`, [id]);
    }
    t.addFile('owner'); // never attached to a message: not listed
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await t.media(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(response.statusCode).toBe(200);
      const page = mediaPageResponseSchema.parse(response.json());
      seen.push(...page.items.map((item) => item.id));
      if (pages === 0)
        expect(page.items[0]).toMatchObject({
          direction: 'received',
          name: 'photo.png',
          mime_type: 'image/png',
          size_bytes: 10,
        });
      cursor = page.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    // Files are inserted before their messages, so created_at follows insert order.
    expect(seen).toEqual([...received].reverse().concat(sentFile));
    const last = mediaPageResponseSchema.parse((await t.media('?limit=50')).json());
    expect(last.next_cursor).toBeNull();
    expect(last.items.at(-1)).toMatchObject({ id: sentFile, direction: 'sent' });
    expect((await t.media('?limit=51')).statusCode).toBe(400);
    expect((await t.media('?cursor=bm9wZQ')).statusCode).toBe(400);
  });

  it("never returns another user's or another agent's files", async () => {
    const t = await setup();
    const bobFile = t.addFile('agent', BOB_AGENT, 'bob');
    await t.agentSays('bob', [bobFile], BOB_AGENT, 'bob');
    const otherFile = t.addFile('agent', OTHER_AGENT);
    await t.agentSays('other', [otherFile], OTHER_AGENT);
    expect(mediaPageResponseSchema.parse((await t.media()).json()).items).toEqual([]);
    expect((await t.media('', 'bob', AGENT)).statusCode).toBe(404);
    expect((await t.media('', 'alice', BOB_AGENT)).statusCode).toBe(404);
    const bobs = mediaPageResponseSchema.parse((await t.media('', 'bob', BOB_AGENT)).json());
    expect(bobs.items.map((item) => item.id)).toEqual([bobFile]);
  });
});
