import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  messageAad,
  newMessageKey,
  sealBody,
  wrapKey,
  type SealedEnvelopeV1,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { DEVICE_KEY_NAME } from './device-key';
import { saveTrusted, type TrustedDevice } from './pairing';
import { PrivateChats } from './private-chats';
import {
  createPhoneContext,
  openMessages,
  openMessagesInSteps,
  type PhoneSealContext,
  type SealedThreadMessage,
} from './sealed-thread';
import { memoryStore } from './test-fixtures';

/**
 * A private chat opens again on every change (each reply chunk, each new message). Only what
 * changed is decrypted again; every check still runs (C3 #11 Task 31, measured on a Moto).
 */

const ACCOUNT = 'con_' + 'a'.repeat(20);
const AGENT = 'claude';
const phone = generateSealKeyPair();
const computer = generateSealKeyPair();
const PHONE_ID = deviceIdFor(phone.publicKey);
const COMPUTER_ID = deviceIdFor(computer.publicKey);
const at = '2026-11-26T00:00:00.000Z';

const trustedComputer: TrustedDevice = {
  id: COMPUTER_ID,
  kind: 'computer',
  name: 'Computer',
  public_key: base64urlEncode(computer.publicKey),
  verified_at: at,
};

function ctxFor(trusted: TrustedDevice[] = [trustedComputer]): PhoneSealContext {
  return createPhoneContext({
    accountId: ACCOUNT,
    agentId: AGENT,
    me: { deviceId: PHONE_ID, publicKey: phone.publicKey, privateKey: phone.privateKey },
    trusted,
    nextSeq: () => 1,
  });
}

function fromComputer(
  text: string,
  seq: number,
  chunk?: { index: number; final: boolean },
): SealedEnvelopeV1 {
  const key = newMessageKey();
  const aad = messageAad({
    accountId: ACCOUNT,
    agentId: AGENT,
    senderDevice: COMPUTER_ID,
    senderSeq: seq,
    ...(chunk !== undefined && { chunk: chunk.index }),
  });
  const { nonce, body } = sealBody(key, { text }, aad);
  return {
    v: 1,
    sender_device: COMPUTER_ID,
    sender_seq: seq,
    nonce,
    body,
    keys: [{ device: PHONE_ID, wrapped: wrapKey(key, computer.privateKey, phone.publicKey, aad) }],
    ...(chunk !== undefined && { chunk }),
  };
}

let ids = 0;
const message = (sealed: SealedEnvelopeV1[], id = `msg_${String(++ids).padStart(20, 'a')}`) =>
  ({ id, kind: 'sealed', author: 'agent', sealed }) as unknown as SealedThreadMessage;

/** Breaks an envelope in place: decrypting it again would fail. */
function spoil(m: SealedThreadMessage): void {
  const e = m.sealed[0] as { body: string };
  e.body = (e.body.startsWith('A') ? 'B' : 'A') + e.body.slice(1);
}

describe('opening a private chat again', () => {
  it('does not decrypt an unchanged message again', () => {
    const ctx = ctxFor();
    const m = message([fromComputer('hello', 1)]);
    expect(openMessages(ctx, [m])).toMatchObject([{ state: 'ok', text: 'hello' }]);
    spoil(m);
    expect(openMessages(ctx, [m])).toMatchObject([{ state: 'ok', text: 'hello' }]);
  });

  it('gives back the same shown entry for an unchanged message', () => {
    const ctx = ctxFor();
    const m = message([fromComputer('hello', 1)]);
    const [first] = openMessages(ctx, [m]);
    const [again] = openMessages(ctx, [m]);
    expect(again).toBe(first);
  });

  it('decrypts a changed message again: a reply that got its next chunk', () => {
    const ctx = ctxFor();
    const id = 'msg_' + 'c'.repeat(20);
    const first = fromComputer('Hel', 4, { index: 0, final: false });
    expect(openMessages(ctx, [message([first], id)])).toMatchObject([
      { state: 'ok', text: 'Hel', partial: true },
    ]);
    const second = fromComputer('lo', 4, { index: 1, final: true });
    const [opened] = openMessages(ctx, [message([first, second], id)]);
    expect(opened).toMatchObject({ state: 'ok', text: 'Hello' });
    expect(opened).not.toHaveProperty('partial');
  });

  it('decrypts a new copy of a message again, so a changed body is caught', () => {
    const ctx = ctxFor();
    const m = message([fromComputer('hello', 1)]);
    openMessages(ctx, [m]);
    const e = m.sealed[0];
    const body = (e.body.startsWith('A') ? 'B' : 'A') + e.body.slice(1);
    const copy = message([{ ...e, body }], m.id);
    expect(openMessages(ctx, [copy])).toMatchObject([{ state: 'couldnt_open' }]);
  });

  it('still drops a replay of a message that opened before', () => {
    const ctx = ctxFor();
    const m = message([fromComputer('hello', 1)]);
    const replay = message(m.sealed);
    expect(openMessages(ctx, [m, replay]).map((o) => o.id)).toEqual([m.id]);
    expect(openMessages(ctx, [m, replay]).map((o) => o.id)).toEqual([m.id]);
  });

  it('stops opening a message once its computer is no longer trusted', () => {
    const ctx = ctxFor();
    const m = message([fromComputer('hello', 1)]);
    openMessages(ctx, [m]);
    ctx.trusted = [];
    expect(openMessages(ctx, [m])).toMatchObject([{ state: 'couldnt_open' }]);
  });

  it('opens in steps with the same result, pausing between steps', async () => {
    const list = Array.from({ length: 250 }, (_, i) => message([fromComputer(`m${i}`, i + 1)]));
    const pause = vi.fn(() => Promise.resolve());
    const stepped = await openMessagesInSteps(ctxFor(), list, pause, 100);
    expect(stepped).toEqual(openMessages(ctxFor(), list));
    expect(pause).toHaveBeenCalledTimes(2);
  });
});

describe('a private chat on the phone', () => {
  it('saves the replay state only when opening changed it', async () => {
    const store = memoryStore();
    await store.setItemAsync(
      DEVICE_KEY_NAME,
      JSON.stringify({
        v: 1,
        public_key: base64urlEncode(phone.publicKey),
        private_key: base64urlEncode(phone.privateKey),
      }),
    );
    await saveTrusted(store, [{ ...trustedComputer, connector_id: ACCOUNT }]);
    const save = vi.fn(() => Promise.resolve());
    const chats = new PrivateChats({
      store,
      replay: { load: () => Promise.resolve({}), save, remove: () => Promise.resolve() },
      addressOf: () => Promise.resolve(`cord-connector://${ACCOUNT}/${AGENT}`),
    });
    await chats.context(AGENT);
    const m = message([fromComputer('hello', 1)]);
    chats.open(AGENT, [m]);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    chats.open(AGENT, [m]);
    chats.open(AGENT, [m]);
    const next = message([fromComputer('again', 2)]);
    chats.open(AGENT, [m, next]);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('tries the save again on the next open when it failed', async () => {
    const store = memoryStore();
    await store.setItemAsync(
      DEVICE_KEY_NAME,
      JSON.stringify({
        v: 1,
        public_key: base64urlEncode(phone.publicKey),
        private_key: base64urlEncode(phone.privateKey),
      }),
    );
    await saveTrusted(store, [{ ...trustedComputer, connector_id: ACCOUNT }]);
    const save = vi
      .fn(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.reject(new Error('disk full')));
    const chats = new PrivateChats({
      store,
      replay: { load: () => Promise.resolve({}), save, remove: () => Promise.resolve() },
      addressOf: () => Promise.resolve(`cord-connector://${ACCOUNT}/${AGENT}`),
    });
    await chats.context(AGENT);
    const m = message([fromComputer('hello', 1)]);
    chats.open(AGENT, [m]);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    chats.open(AGENT, [m]);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  });
});
