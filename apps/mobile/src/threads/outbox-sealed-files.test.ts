import {
  base64urlDecode,
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  messageAad,
  fileAad,
  openFile,
  openBody,
  unwrapKey,
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
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('@/api', () => ({ ApiError }));
vi.mock('@/auth', () => ({ addBeforeSignOut: () => undefined, authHeaders: () => ({}) }));
vi.mock('@/config/env', () => ({ mobileEnv: { ok: false } }));
vi.mock('@/hooks/useResource', () => ({ STATUS_POLL_MS: 20_000 }));

import { loadOrCreateDeviceKey } from '../e2e/device-key';
import { confirmPairing } from '../e2e/pairing';
import { PrivateChats } from '../e2e/private-chats';
import { memoryStore as keychain } from '../e2e/test-fixtures';
import { ChatController } from './chats';
import { Outbox } from './outbox';
import { memoryStore, type OutboxFiles } from './outbox-storage';
import { SearchIndex, memorySearchStore } from './search-index';

const privateAgent = 'agt_abcdefghij0123456789';
const ACCOUNT = 'con_' + 'a'.repeat(20);
const LOCAL = 'claude';
const computer = generateSealKeyPair();
const COMPUTER_ID = deviceIdFor(computer.publicKey);
const at = '2026-11-25T00:00:00.000Z';

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

const sealedMsg = (sealed: SealedEnvelopeV1, clientId: string) =>
  ({
    id: 'msg_' + 'z'.repeat(20),
    agent_id: privateAgent,
    seq: 1,
    rev: 1,
    created_at: at,
    updated_at: at,
    kind: 'sealed',
    author: 'user',
    sealed: [sealed],
    client_id: clientId,
  }) as ThreadMessage;

const PLAIN = new Uint8Array(1500).map((_, i) => i % 251);
const PHOTO = {
  clientId: 'f1',
  uri: 'file:///photo.jpg',
  name: 'photo.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: PLAIN.length,
};

async function setup() {
  const store = keychain();
  const me = await loadOrCreateDeviceKey(store);
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
  const uploads: { clientId: string; bytes: Uint8Array }[] = [];
  const posts: { clientId: string; sealed: SealedEnvelopeV1; attachmentIds?: string[] }[] = [];
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
    listMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    markRead: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
    uploadFile: vi.fn(),
    uploadSealedFile: vi.fn((_a: string, file: { clientId: string; bytes: Uint8Array }) => {
      uploads.push(file);
      return Promise.resolve({ id: `fil_${'a'.repeat(19)}${uploads.length}` });
    }),
    sendSealedMessage: vi.fn(
      (
        _a: string,
        body: { clientId: string; sealed: SealedEnvelopeV1; attachmentIds?: string[] },
      ) => {
        posts.push(body);
        return Promise.resolve(sealedMsg(body.sealed, body.clientId));
      },
    ),
  };
  const cacheOwn = vi.fn((_id: string, _uri: string) => Promise.resolve());
  const privacy = new PrivateChats({
    store,
    replay: memoryStore(),
    addressOf: () => Promise.resolve(`cord-connector://${ACCOUNT}/${LOCAL}`),
  });
  const controller = new ChatController(api as unknown as TwringApi, undefined, {
    outbox: memoryStore(),
    drafts: memoryStore(),
    search: new SearchIndex(memorySearchStore()),
    privacy,
    sealedFiles: {
      read: () => Promise.resolve(PLAIN),
      cacheOwn,
    },
  });
  await controller.refreshList();
  return { controller, api, uploads, posts, cacheOwn, me };
}

describe('sealed photos and files from the phone', () => {
  it('a private photo is sealed, uploaded as a blob, then the envelope names it', async () => {
    const t = await setup();
    t.controller.sendFiles(privateAgent, 'look', [PHOTO]);
    await vi.waitFor(() => expect(t.api.sendSealedMessage).toHaveBeenCalled());
    expect(t.api.sendMessage).not.toHaveBeenCalled();
    expect(t.api.uploadFile).not.toHaveBeenCalled();
    expect(t.uploads).toHaveLength(1);
    const blob = t.uploads[0].bytes;
    expect(blob.length).toBe(PLAIN.length + 40);
    expect(Buffer.from(blob).includes(Buffer.from(PLAIN.subarray(0, 32)))).toBe(false);
    const post = t.posts[0];
    const payload = openPayloadAsComputer(post.sealed, t.me.publicKey);
    expect(payload.text).toBe('look');
    expect(payload.files).toEqual([
      {
        file_id: post.attachmentIds![0],
        key: expect.any(String) as string,
        name: 'photo.jpg',
        mime: 'image/jpeg',
        size: PLAIN.length,
      },
    ]);
    expect(post.attachmentIds).toEqual([`fil_${'a'.repeat(19)}1`]);
    const opened = openFile(
      base64urlDecode(payload.files![0].key),
      blob,
      fileAad({ accountId: ACCOUNT, agentId: LOCAL }),
    );
    expect(Buffer.from(opened).equals(Buffer.from(PLAIN))).toBe(true);
    // The sent photo shows from the phone's own copy: no download.
    expect(t.cacheOwn).toHaveBeenCalledWith(post.attachmentIds![0], 'file:///photo.jpg');
  });

  it('a retry after the send failed reuses the uploaded file and its key', async () => {
    const t = await setup();
    t.api.sendSealedMessage.mockRejectedValueOnce(
      new ApiError('http', 'bad_request', undefined, undefined, 400),
    );
    const clientId = t.controller.sendFiles(privateAgent, 'look', [PHOTO]);
    await vi.waitFor(() => expect(t.controller.getPending(privateAgent)[0]?.state).toBe('failed'));
    expect(t.uploads).toHaveLength(1);
    t.controller.retry(clientId);
    await vi.waitFor(() => expect(t.posts).toHaveLength(1));
    expect(t.uploads).toHaveLength(1);
    expect(t.api.sendSealedMessage).toHaveBeenCalledTimes(2);
    expect(t.api.sendSealedMessage.mock.calls[1][1].attachmentIds).toEqual([
      `fil_${'a'.repeat(19)}1`,
    ]);
  });

  it('a 0-byte or over-10 MB file is refused before sealing', async () => {
    const t = await setup();
    t.controller.sendFiles(privateAgent, '', [{ ...PHOTO, sizeBytes: 0 }]);
    t.controller.sendFiles(privateAgent, '', [{ ...PHOTO, clientId: 'f2', sizeBytes: 10_485_761 }]);
    await vi.waitFor(() =>
      expect(t.controller.getPending(privateAgent).map((p) => p.errorCode)).toEqual([
        'unsupported_file_type',
        'file_too_large',
      ]),
    );
    expect(t.uploads).toHaveLength(0);
    expect(t.api.sendSealedMessage).not.toHaveBeenCalled();
  });
});

describe('a restored private file item', () => {
  it('restored file item without an envelope is failed private_unsent', async () => {
    const store = memoryStore();
    store.value = {
      version: 1,
      items: [
        {
          clientId: 'c1',
          agentId: privateAgent,
          text: '',
          privateChat: true,
          state: 'sending',
          createdAt: at,
          files: [
            {
              clientId: 'f1',
              uri: 'doc://outbox/c1/f1-photo.jpg',
              name: 'photo.jpg',
              mimeType: 'image/jpeg',
              sizeBytes: 10,
              sealedUpload: { id: 'fil_aaaaaaaaaaaaaaaaaaaa', key: 'k' },
            },
          ],
        },
      ],
    };
    const present = new Set(['doc://outbox/c1/f1-photo.jpg']);
    const files: OutboxFiles = {
      keep: (_c, uri) => Promise.resolve(uri),
      exists: (uri) => present.has(uri),
      remove: (uri) => void present.delete(uri),
    };
    const send = vi.fn();
    const upload = vi.fn();
    const outbox = new Outbox(
      send,
      () => undefined,
      undefined,
      upload,
      { store, files: () => Promise.resolve(files) },
      {
        known: () => true,
        isPrivate: () => Promise.resolve(true),
        seal: vi.fn(),
        openOwn: () => Promise.resolve(undefined),
        sealFile: vi.fn(),
        uploadSealed: vi.fn(),
        cacheOwnFile: vi.fn(),
      },
    );
    await outbox.hydrated;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [item] = outbox.list(privateAgent);
    expect(item).toMatchObject({ state: 'failed', errorCode: 'private_unsent' });
    outbox.retry('c1');
    expect(outbox.list(privateAgent)[0]?.state).toBe('failed');
    expect(send).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    outbox.discard('c1');
    expect(outbox.list(privateAgent)).toEqual([]);
    await vi.waitFor(() => expect(present.size).toBe(0));
  });
});
