import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  messageAad,
  newMessageKey,
  openBody,
  sealBody,
  unwrapKey,
  wrapKey,
  type SealedEnvelopeV1,
  type ThreadMessage,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type TwringApi } from '../api/client';

vi.mock('./search-store', () => ({
  sqliteSearchStore: () => undefined,
  deleteSearchDatabase: () => Promise.resolve(),
}));
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('@react-native-community/netinfo', () => ({
  default: { addEventListener: () => () => undefined },
}));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('@/api', () => ({ ApiError }));
vi.mock('@/auth', () => ({ addBeforeSignOut: () => undefined, authHeaders: () => ({}) }));
vi.mock('@/config/env', () => ({ mobileEnv: { ok: false } }));
vi.mock('@/hooks/useResource', () => ({ STATUS_POLL_MS: 20_000 }));

import { loadOrCreateDeviceKey, SEQ_KEY_NAME } from '../e2e/device-key';
import { confirmPairing } from '../e2e/pairing';
import { PrivateChats } from '../e2e/private-chats';
import { memoryStore as keychain } from '../e2e/test-fixtures';
import { ChatController } from './chats';
import { memoryStore } from './outbox-storage';
import { SearchIndex, memorySearchStore } from './search-index';

const privateAgent = 'agt_abcdefghij0123456789';
const ACCOUNT = 'con_' + 'a'.repeat(20);
const LOCAL = 'claude';
const computer = generateSealKeyPair();
const COMPUTER_ID = deviceIdFor(computer.publicKey);
const at = '2026-11-25T00:00:00.000Z';

/** What the computer sends (apps/connector/src/e2e/sealed.ts). */
function fromComputer(phoneId: string, phoneKey: Uint8Array, text: string, seq: number) {
  const key = newMessageKey();
  const aad = messageAad({
    accountId: ACCOUNT,
    agentId: LOCAL,
    senderDevice: COMPUTER_ID,
    senderSeq: seq,
    chunk: 0,
  });
  const { nonce, body } = sealBody(key, { text }, aad);
  const envelope: SealedEnvelopeV1 = {
    v: 1,
    sender_device: COMPUTER_ID,
    sender_seq: seq,
    nonce,
    body,
    keys: [{ device: phoneId, wrapped: wrapKey(key, computer.privateKey, phoneKey, aad) }],
    chunk: { index: 0, final: true },
  };
  return envelope;
}

/** The computer opening what the phone sent. */
function openAsComputer(env: SealedEnvelopeV1, phoneKey: Uint8Array): string {
  return openPayloadAsComputer(env, phoneKey).text;
}

function openPayloadAsComputer(env: SealedEnvelopeV1, phoneKey: Uint8Array) {
  const aad = messageAad({
    accountId: ACCOUNT,
    agentId: LOCAL,
    senderDevice: env.sender_device,
    senderSeq: env.sender_seq,
  });
  const mine = env.keys.find((k) => k.device === COMPUTER_ID)!;
  const key = unwrapKey(mine.wrapped, computer.privateKey, phoneKey, aad);
  return openBody(key, env.nonce, env.body, aad);
}

let ids = 0;
const sealedMsg = (sealed: SealedEnvelopeV1, author: 'user' | 'agent', clientId?: string) =>
  ({
    id: `msg_${String.fromCharCode(97 + (ids++ % 26)).repeat(20)}`,
    agent_id: privateAgent,
    seq: ids,
    rev: ids,
    created_at: at,
    updated_at: at,
    kind: 'sealed',
    author,
    sealed: [sealed],
    ...(clientId !== undefined && { client_id: clientId }),
  }) as ThreadMessage;

async function setup(
  options: { paired?: boolean; sendFails?: boolean; devices?: () => Promise<unknown> } = {},
) {
  const store = keychain();
  const me = await loadOrCreateDeviceKey(store);
  if (options.paired !== false)
    await confirmPairing(
      { store },
      {
        id: COMPUTER_ID,
        kind: 'computer',
        name: 'Computer',
        public_key: base64urlEncode(computer.publicKey),
        verified_at: at,
      },
    );
  const posts: unknown[] = [];
  const seqAtPost: (string | undefined)[] = [];
  const fromAgent = sealedMsg(
    fromComputer(me.deviceId, me.publicKey, 'hello from computer', 1),
    'agent',
  );
  const api = {
    listThreads: vi.fn().mockResolvedValue({
      threads: [
        {
          agent_id: privateAgent,
          last_message: null,
          unread: 0,
          last_message_at: null,
          read_seq: 0,
          private: true,
        },
      ],
      files: true,
    }),
    listMessages: vi.fn().mockResolvedValue({ messages: [fromAgent], hasMore: false }),
    markRead: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn((_a: string, body: unknown) => {
      posts.push(body);
      return Promise.reject(new ApiError('http', 'private_thread', undefined, undefined, 409));
    }),
    sendSealedMessage: vi.fn((_a: string, body: { clientId: string; sealed: SealedEnvelopeV1 }) => {
      posts.push(body);
      seqAtPost.push(store.m.get(SEQ_KEY_NAME));
      if (options.sendFails)
        return Promise.reject(new ApiError('http', 'bad_request', undefined, undefined, 400));
      return Promise.resolve(sealedMsg(body.sealed, 'user', body.clientId));
    }),
  };
  const outbox = memoryStore();
  const replay = memoryStore();
  const searchStore = memorySearchStore();
  const drafts = memoryStore();
  const privacy = new PrivateChats({
    store,
    replay,
    addressOf: () => Promise.resolve(`cord-connector://${ACCOUNT}/${LOCAL}`),
    ...(options.devices !== undefined && { devices: options.devices }),
  });
  const controller = new ChatController(api as unknown as TwringApi, undefined, {
    outbox,
    drafts,
    search: new SearchIndex(searchStore),
    privacy,
  });
  await controller.refreshList();
  return { controller, api, posts, seqAtPost, outbox, replay, drafts, searchStore, me, store };
}

describe('private chats in the chat data layer', () => {
  it('sends a sealed body, never text, for a private agent', async () => {
    const t = await setup();
    t.controller.send(privateAgent, 'hello');
    await vi.waitFor(() => expect(t.api.sendSealedMessage).toHaveBeenCalled());
    expect(t.api.sendMessage).not.toHaveBeenCalled();
    const post = t.posts[0] as { sealed: SealedEnvelopeV1 };
    expect(post).toHaveProperty('sealed');
    expect(JSON.stringify(post)).not.toContain('hello');
    expect(openAsComputer(post.sealed, t.me.publicKey)).toBe('hello');
  });

  it('saves the seq in the keychain before the post goes out', async () => {
    const t = await setup();
    t.controller.send(privateAgent, 'one');
    await vi.waitFor(() => expect(t.api.sendSealedMessage).toHaveBeenCalledTimes(1));
    t.controller.send(privateAgent, 'two');
    await vi.waitFor(() => expect(t.api.sendSealedMessage).toHaveBeenCalledTimes(2));
    const seqs = (t.posts as { sealed: SealedEnvelopeV1 }[]).map((p) => p.sealed.sender_seq);
    // Each seq (it follows the clock, ADR-044 recovery) is saved before its post goes out.
    expect(t.seqAtPost).toEqual(seqs.map(String));
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
  });

  it('shows the opened text, and keeps plaintext out of everything saved on the phone', async () => {
    const t = await setup({ sendFails: true });
    await t.controller.open(privateAgent);
    await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)).toBeDefined());
    expect(t.controller.getOpened(privateAgent)).toEqual([
      expect.objectContaining({ state: 'ok', author: 'agent', text: 'hello from computer' }),
    ]);
    t.controller.send(privateAgent, 'hello there');
    await vi.waitFor(() => expect(t.controller.getPending(privateAgent)[0]?.state).toBe('failed'));
    await (t.controller as unknown as { outbox: { flush(): Promise<void> } }).outbox.flush();
    // Opened text is never written anywhere on the phone (C3 #11).
    const saved = JSON.stringify([
      t.outbox.value,
      t.replay.value,
      [...t.searchStore.rows.values()],
    ]);
    expect(saved).not.toContain('hello from computer');
    expect(saved).not.toContain('hello there');
    // The queued message is saved, sealed only.
    expect(JSON.stringify(t.outbox.value)).toContain('"sealed"');
    expect(t.replay.value).toBeDefined();
  });

  it('a failed seal keeps the message in the outbox as failed, not sent as text', async () => {
    const t = await setup({ paired: false });
    t.controller.send(privateAgent, 'hello');
    await vi.waitFor(() => expect(t.controller.getPending(privateAgent)[0]?.state).toBe('failed'));
    expect(t.controller.getPending(privateAgent)[0]?.errorCode).toBe('pair_again');
    expect(t.api.sendMessage).not.toHaveBeenCalled();
    expect(t.api.sendSealedMessage).not.toHaveBeenCalled();
    expect(t.store.m.has(SEQ_KEY_NAME)).toBe(false);
    await (t.controller as unknown as { outbox: { flush(): Promise<void> } }).outbox.flush();
    expect(JSON.stringify(t.outbox.value ?? null)).not.toContain('hello');
  });

  it('asks to pair again when no computer is paired', async () => {
    const t = await setup({ paired: false });
    await t.controller.open(privateAgent);
    await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)).toBeDefined());
    expect(t.controller.getPairAgain(privateAgent)).toBe(true);
    const paired = await setup();
    await paired.controller.open(privateAgent);
    await vi.waitFor(() => expect(paired.controller.getOpened(privateAgent)).toBeDefined());
    expect(paired.controller.getPairAgain(privateAgent)).toBe(false);
  });

  it('a sent sealed message leaves the outbox when the server lists it', async () => {
    const t = await setup();
    t.controller.send(privateAgent, 'hello');
    await vi.waitFor(() => expect(t.controller.getPending(privateAgent)).toEqual([]));
    expect(t.controller.getChat(privateAgent).messages.some((m) => m.kind === 'sealed')).toBe(true);
  });

  it('sends a voice note with consent only after "Send anyway"', async () => {
    const t = await setup();
    const voice = vi
      .fn()
      .mockRejectedValue(new ApiError('http', 'private_thread', undefined, undefined, 409));
    (t.api as unknown as { sendVoiceNote: typeof voice }).sendVoiceNote = voice;
    t.controller.sendVoice(privateAgent, 'file:///a.m4a', 2000, undefined, {
      serverReadable: true,
    });
    t.controller.sendVoice(privateAgent, 'file:///b.m4a', 2000);
    await vi.waitFor(() => expect(voice).toHaveBeenCalledTimes(2));
    const byUri = new Map(voice.mock.calls.map((call) => [call[3], call[6]]));
    expect(byUri.get('file:///a.m4a')).toBe(true);
    expect(byUri.get('file:///b.m4a')).toBeUndefined();
    await vi.waitFor(() =>
      expect(t.controller.getPending(privateAgent).map((p) => p.errorCode)).toEqual([
        'private_thread',
        'private_thread',
      ]),
    );
  });

  it('after a restart, a sealed queued message shows its text again and resends sealed', async () => {
    const first = await setup({ sendFails: true });
    first.controller.send(privateAgent, 'kept');
    await vi.waitFor(() =>
      expect(first.controller.getPending(privateAgent)[0]?.state).toBe('failed'),
    );
    await (first.controller as unknown as { outbox: { flush(): Promise<void> } }).outbox.flush();
    const privacy = new PrivateChats({
      store: first.store,
      replay: first.replay,
      addressOf: () => Promise.resolve(`cord-connector://${ACCOUNT}/${LOCAL}`),
    });
    const again = new ChatController(first.api as unknown as TwringApi, undefined, {
      outbox: first.outbox,
      privacy,
    });
    await vi.waitFor(() => expect(again.getPending(privateAgent)[0]?.text).toBe('kept'));
  });

  it('signing out forgets the device key, its counter and the trusted computers', async () => {
    const t = await setup();
    t.controller.send(privateAgent, 'hello');
    await vi.waitFor(() => expect(t.api.sendSealedMessage).toHaveBeenCalled());
    expect(t.store.m.size).toBeGreaterThan(0);
    await t.controller.clear({ forget: true });
    // The next account on this phone must never seal to this account's computer.
    expect([...t.store.m.keys()]).toEqual([]);
  });

  it('two messages sent at once get two seqs', async () => {
    const t = await setup();
    t.controller.send(privateAgent, 'one');
    t.controller.send(privateAgent, 'two');
    await vi.waitFor(() => expect(t.api.sendSealedMessage).toHaveBeenCalledTimes(2));
    const seqs = (t.posts as { sealed: SealedEnvelopeV1 }[]).map((p) => p.sealed.sender_seq);
    expect(new Set(seqs).size).toBe(2);
  });

  it('a corrupt replay file opens the chat anyway, with no crash', async () => {
    const t = await setup();
    const replay = memoryStore();
    replay.value = { [privateAgent]: { floor: 'bad' } };
    const privacy = new PrivateChats({
      store: t.store,
      replay,
      addressOf: () => Promise.resolve(`cord-connector://${ACCOUNT}/${LOCAL}`),
    });
    const controller = new ChatController(t.api as unknown as TwringApi, undefined, { privacy });
    await controller.refreshList();
    await controller.open(privateAgent);
    await vi.waitFor(() => expect(controller.getOpened(privateAgent)).toBeDefined());
    expect(controller.getOpened(privateAgent)?.[0]).toMatchObject({ state: 'ok' });
  });

  it('a retry after a failed post resends the same sealed body and seq', async () => {
    const t = await setup({ sendFails: true });
    t.controller.send(privateAgent, 'again');
    await vi.waitFor(() => expect(t.controller.getPending(privateAgent)[0]?.state).toBe('failed'));
    const sent = t.posts.length;
    const clientId = t.controller.getPending(privateAgent)[0].clientId;
    t.controller.retry(clientId);
    await vi.waitFor(() => expect(t.controller.getPending(privateAgent)[0]?.state).toBe('failed'));
    const all = t.posts as { clientId: string; sealed: SealedEnvelopeV1 }[];
    expect(all.length).toBeGreaterThan(sent);
    expect(new Set(all.map((p) => JSON.stringify(p.sealed))).size).toBe(1);
    expect(new Set(all.map((p) => p.clientId))).toEqual(new Set([clientId]));
    // One seq was taken, never a second one for the retry.
    expect(t.store.m.get(SEQ_KEY_NAME)).toBe(String(all[0].sealed.sender_seq));
  });

  it('builds a 280-character reply quote inside the sealed payload', async () => {
    const t = await setup();
    const long = sealedMsg(
      fromComputer(t.me.deviceId, t.me.publicKey, 'x'.repeat(400), 2),
      'agent',
    );
    t.api.listMessages.mockResolvedValue({ messages: [long], hasMore: false });
    await t.controller.open(privateAgent);
    await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)?.length).toBe(1));
    t.controller.send(privateAgent, 'ok', long.id);
    await vi.waitFor(() => expect(t.api.sendSealedMessage).toHaveBeenCalled());
    const post = t.posts[0] as { sealed: SealedEnvelopeV1; replyTo?: string };
    const payload = openPayloadAsComputer(post.sealed, t.me.publicKey);
    expect(payload.quote).toMatchObject({ message_id: long.id, from: 'agent' });
    expect(payload.quote!.text).toHaveLength(281);
    expect(post.replyTo).toBe(long.id);
    expect(post).not.toHaveProperty('reply_to_text');
    expect(JSON.stringify(post)).not.toContain('xxxx');
  });

  it('a reply to a message that could not be opened has no quote', async () => {
    const t = await setup();
    const env = fromComputer(t.me.deviceId, t.me.publicKey, 'secret', 2);
    const body = (env.body.startsWith('A') ? 'B' : 'A') + env.body.slice(1);
    const broken = sealedMsg({ ...env, body }, 'agent');
    t.api.listMessages.mockResolvedValue({ messages: [broken], hasMore: false });
    await t.controller.open(privateAgent);
    await vi.waitFor(() =>
      expect(t.controller.getOpened(privateAgent)?.[0]).toMatchObject({ state: 'couldnt_open' }),
    );
    t.controller.send(privateAgent, 'what was that?', broken.id);
    await vi.waitFor(() => expect(t.api.sendSealedMessage).toHaveBeenCalled());
    const post = t.posts[0] as { sealed: SealedEnvelopeV1 };
    expect(openPayloadAsComputer(post.sealed, t.me.publicKey).quote).toBeUndefined();
  });

  it('search finds a private message by its opened text, kept in memory only', async () => {
    const t = await setup();
    await t.controller.open(privateAgent);
    await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)).toBeDefined());
    await vi.waitFor(async () =>
      expect((await t.controller.searchChats('computer')).map((r) => r.agentId)).toContain(
        privateAgent,
      ),
    );
    const [hit] = await t.controller.searchChats('computer');
    expect(hit).toMatchObject({ role: 'agent', text: 'hello from computer' });
    expect(JSON.stringify([...t.searchStore.rows.values()])).not.toContain('hello from computer');
  });

  it('Remove this phone drops opened text from search and the chat (R3-3)', async () => {
    const t = await setup();
    await t.controller.open(privateAgent);
    await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)).toBeDefined());
    await vi.waitFor(async () =>
      expect(await t.controller.searchChats('computer')).toHaveLength(1),
    );
    await t.controller.forgetPrivateKeys();
    expect(await t.controller.searchChats('computer')).toHaveLength(0);
    expect(JSON.stringify(t.controller.getOpened(privateAgent) ?? [])).not.toContain(
      'hello from computer',
    );
  });

  it('a phone removed by another phone drops opened text the same way (R3-4)', async () => {
    let removed = false;
    const t = await setup({
      devices: () =>
        Promise.resolve({
          devices: removed
            ? [
                {
                  id: t.me.deviceId,
                  kind: 'phone',
                  name: 'Phone',
                  public_key: base64urlEncode(t.me.publicKey),
                  added_at: at,
                  revoked_at: at,
                },
              ]
            : [],
        }),
    });
    await t.controller.open(privateAgent);
    await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)).toBeDefined());
    await vi.waitFor(async () =>
      expect(await t.controller.searchChats('computer')).toHaveLength(1),
    );
    removed = true;
    t.controller.resetPrivate();
    t.controller.getOpened(privateAgent);
    await vi.waitFor(async () =>
      expect(await t.controller.searchChats('computer')).toHaveLength(0),
    );
    expect(t.replay.value).toBeUndefined();
  });

  it('removes opened text an earlier version saved on the phone', async () => {
    const t = await setup();
    const listed = (await t.api.listMessages()) as { messages: ThreadMessage[] };
    const id = listed.messages[0].id;
    await t.searchStore.upsert([
      {
        id,
        agentId: privateAgent,
        role: 'agent',
        text: 'hello from computer',
        createdAt: at,
        seq: 1,
      },
    ]);
    await t.controller.open(privateAgent);
    await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)).toBeDefined());
    await vi.waitFor(() => expect(t.searchStore.rows.has(id)).toBe(false));
    expect(await t.controller.searchChats('computer')).toHaveLength(1);
  });

  it('search finds it again after the private chat reloads', async () => {
    const t = await setup();
    await t.controller.open(privateAgent);
    await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)).toBeDefined());
    await t.controller.clear();
    expect(await t.controller.searchChats('computer')).toHaveLength(0);
    await t.controller.refreshList();
    await t.controller.open(privateAgent);
    await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)).toBeDefined());
    await vi.waitFor(async () =>
      expect(await t.controller.searchChats('computer')).toHaveLength(1),
    );
    expect(t.searchStore.rows.size).toBe(0);
  });

  it('a message that could not be opened is never searchable', async () => {
    const t = await setup();
    const env = fromComputer(t.me.deviceId, t.me.publicKey, 'secret words', 2);
    const body = (env.body.startsWith('A') ? 'B' : 'A') + env.body.slice(1);
    t.api.listMessages.mockResolvedValue({
      messages: [sealedMsg({ ...env, body }, 'agent')],
      hasMore: false,
    });
    await t.controller.open(privateAgent);
    await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)).toBeDefined());
    expect(t.searchStore.rows.size).toBe(0);
    expect(await t.controller.searchChats('secret')).toHaveLength(0);
  });

  it('sign-out clears the in-memory private search', async () => {
    const t = await setup();
    await t.controller.open(privateAgent);
    await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)).toBeDefined());
    await vi.waitFor(async () =>
      expect(await t.controller.searchChats('computer')).toHaveLength(1),
    );
    await t.controller.clear({ forget: true });
    expect(await t.controller.searchChats('computer')).toHaveLength(0);
  });

  it('a private draft stays in memory and never reaches the drafts file', async () => {
    const t = await setup();
    t.controller.setDraft(privateAgent, 'my api key is sk-123');
    t.controller.setDraft('agt_ordinary0000000000', 'plain draft');
    t.controller.flushDrafts();
    await vi.waitFor(() => expect(t.drafts.value).toBeDefined());
    expect(JSON.stringify(t.drafts.value)).not.toContain('sk-123');
    expect(JSON.stringify(t.drafts.value)).toContain('plain draft');
    expect(await t.controller.getDraft(privateAgent)).toBe('my api key is sk-123');
  });

  it('a draft saved before the chat became private is removed from the file', async () => {
    const t = await setup();
    await t.drafts.save({ version: 1, drafts: { [privateAgent]: 'old words' } });
    const fresh = new ChatController(t.api as unknown as TwringApi, undefined, {
      drafts: t.drafts,
    });
    await fresh.refreshList();
    await vi.waitFor(() => expect(JSON.stringify(t.drafts.value ?? '')).not.toContain('old words'));
  });

  it('a draft typed after the first chat list load failed is not written to the file', async () => {
    const t = await setup();
    await t.drafts.save({ version: 1, drafts: { [privateAgent]: 'old secret sk-old' } });
    const api = {
      ...t.api,
      listThreads: vi.fn().mockRejectedValue(new ApiError('network', 'agent_offline')),
    };
    const fresh = new ChatController(api as unknown as TwringApi, undefined, {
      drafts: t.drafts,
    });
    await fresh.refreshList();
    // The list never arrived: nothing says this chat is ordinary.
    fresh.setDraft(privateAgent, 'my api key is sk-123');
    fresh.flushDrafts();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(JSON.stringify(t.drafts.value ?? '')).not.toContain('sk-123');
  });

  it('keeps the share job when the chat list has not loaded', async () => {
    const t = await setup();
    // Loaded: the private chats are named.
    expect(t.controller.loadedPrivateAgentIds()).toEqual([privateAgent]);
    const api = {
      ...t.api,
      listThreads: vi.fn().mockRejectedValue(new ApiError('network', 'agent_offline')),
    };
    const fresh = new ChatController(api as unknown as TwringApi, undefined, {});
    await fresh.refreshList();
    // Never loaded: not an empty list, so no share run may finish a job on it.
    expect(fresh.loadedPrivateAgentIds()).toBeUndefined();
  });

  it('opens the whole chat for export without moving the replay window', async () => {
    const t = await setup();
    const listed = (await t.api.listMessages()) as { messages: ThreadMessage[] };
    const opened = await t.controller.openForExport(privateAgent, listed.messages);
    expect(opened).toEqual([expect.objectContaining({ state: 'ok', text: 'hello from computer' })]);
    // Opening again for the chat still works: export did not use the seq up.
    await t.controller.open(privateAgent);
    await vi.waitFor(() =>
      expect(t.controller.getOpened(privateAgent)?.[0]).toMatchObject({ state: 'ok' }),
    );
  });

  it('a new message hands only its own text to search, not the whole chat again', async () => {
    const recorded = vi.spyOn(SearchIndex.prototype, 'recordPrivate');
    try {
      const t = await setup();
      await t.controller.open(privateAgent);
      await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)).toBeDefined());
      const texts = () =>
        recorded.mock.calls.map(([rows]) => rows.map((row: { text: string }) => row.text));
      expect(texts()).toEqual([['hello from computer']]);
      const next = sealedMsg(
        fromComputer(t.me.deviceId, t.me.publicKey, 'second reply', 2),
        'agent',
      );
      t.controller.frame({ type: 'message.upserted', message: next });
      await vi.waitFor(() => expect(t.controller.getOpened(privateAgent)).toHaveLength(2));
      expect(texts()).toEqual([['hello from computer'], ['second reply']]);
    } finally {
      recorded.mockRestore();
    }
  });
});
