import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  messageAad,
  newMessageKey,
  sealBody,
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

import { loadOrCreateDeviceKey } from '../e2e/device-key';
import { confirmPairing } from '../e2e/pairing';
import { PrivateChats } from '../e2e/private-chats';
import { memoryStore as keychain } from '../e2e/test-fixtures';
import { ChatController } from './chats';
import { memoryStore } from './outbox-storage';

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

describe('Chats list preview races', () => {
  it('Clear chat while the list preview is opening keeps no opened text', async () => {
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
    const last = sealedMsg(fromComputer(me.deviceId, me.publicKey, 'secret plans', 1), 'agent');
    const api = {
      listThreads: vi.fn().mockResolvedValue({
        threads: [
          {
            agent_id: privateAgent,
            last_message: last,
            unread: 1,
            last_message_at: at,
            read_seq: 0,
            private: true,
          },
        ],
        files: true,
      }),
    };
    const privacy = new PrivateChats({
      store,
      replay: memoryStore(),
      addressOf: () => Promise.resolve(`cord-connector://${ACCOUNT}/${LOCAL}`),
    });
    const controller = new ChatController(api as unknown as TwringApi, undefined, {
      summaries: memoryStore(),
      previews: store,
      privacy,
    });
    await controller.refreshList();
    expect(controller.getPreview(privateAgent)).toBeUndefined();
    // The user clears the chat while the preview is still being opened.
    controller.forgetChat(privateAgent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(JSON.stringify([...store.m.values()])).not.toContain('secret plans');
  });
});
