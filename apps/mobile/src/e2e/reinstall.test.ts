import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  messageAad,
  newMessageKey,
  sealBody,
  wrapKey,
  type E2eDevice,
  type SealedEnvelopeV1,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { DEVICE_KEY_NAME } from './device-key';
import { LOST_KEYS, lostKeyMessage, REINSTALLED } from './devices';
import { loadTrusted, saveTrusted, type TrustedDevice } from './pairing';
import { PrivateChats, SealError } from './private-chats';
import { PAIR_AGAIN } from './private-state';
import { createPhoneContext, openMessages, type SealedThreadMessage } from './sealed-thread';
import { memoryStore } from './test-fixtures';

/** A reinstalled computer, a lost phone key, and one computer per agent (Task 30, C3 #11 P4a). */

const CON_A = `con_${'a'.repeat(20)}`;
const CON_B = `con_${'b'.repeat(20)}`;
const AGENT = 'claude-code';
const at = '2026-11-20T10:00:00.000Z';

const keys = () => {
  const pair = generateSealKeyPair();
  return { ...pair, id: deviceIdFor(pair.publicKey), pub: base64urlEncode(pair.publicKey) };
};
const computerA = keys();
const computerB = keys();
const phone = keys();

const trusted = (k: ReturnType<typeof keys>, connector?: string): TrustedDevice => ({
  id: k.id,
  kind: 'computer',
  name: 'Laptop',
  public_key: k.pub,
  verified_at: at,
  ...(connector !== undefined && { connector_id: connector }),
});
const listed = (k: ReturnType<typeof keys>, extra: Partial<E2eDevice> = {}): E2eDevice => ({
  id: k.id,
  kind: 'computer',
  name: 'Laptop',
  public_key: k.pub,
  added_at: at,
  connector_id: CON_A,
  ...extra,
});

function chats(store: ReturnType<typeof memoryStore>, devices: E2eDevice[] | undefined) {
  return new PrivateChats({
    store,
    replay: {
      load: () => Promise.resolve({}),
      save: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
    addressOf: () => Promise.resolve(`cord-connector://${CON_A}/${AGENT}`),
    ...(devices !== undefined && { devices: () => Promise.resolve({ devices }) }),
  });
}

async function phoneWithKey() {
  const store = memoryStore();
  await store.setItemAsync(
    DEVICE_KEY_NAME,
    JSON.stringify({ v: 1, public_key: phone.pub, private_key: base64urlEncode(phone.privateKey) }),
  );
  return store;
}

/** A reply sealed by `from` with chat A's AAD, wrapped to the phone. */
function replyFrom(from: ReturnType<typeof keys>, seq = 1): SealedEnvelopeV1 {
  const key = newMessageKey();
  const aad = messageAad({
    accountId: CON_A,
    agentId: AGENT,
    senderDevice: from.id,
    senderSeq: seq,
  });
  const { nonce, body } = sealBody(key, { text: 'hello' }, aad);
  return {
    v: 1,
    sender_device: from.id,
    sender_seq: seq,
    nonce,
    body,
    keys: [{ device: phone.id, wrapped: wrapKey(key, from.privateKey, phone.publicKey, aad) }],
  };
}
let n = 0;
const msg = (sealed: SealedEnvelopeV1): SealedThreadMessage =>
  ({
    id: `msg_${String(++n).padStart(20, 'a')}`,
    kind: 'sealed',
    author: 'agent',
    sealed: [sealed],
  }) as unknown as SealedThreadMessage;
const ctxWith = (list: TrustedDevice[]) =>
  createPhoneContext({
    accountId: CON_A,
    agentId: AGENT,
    me: { deviceId: phone.id, publicKey: phone.publicKey, privateKey: phone.privateKey },
    trusted: list,
    nextSeq: () => 1,
  });

describe('a reinstalled computer (Task 30)', () => {
  it('new connector key is never trusted silently', async () => {
    const store = await phoneWithKey();
    await saveTrusted(store, [trusted(computerA, CON_A)]);
    const fresh = keys();
    const c = chats(store, [listed(computerA), listed(fresh)]);
    await c.context(AGENT);
    expect(c.notice(AGENT)).toBe('Your computer was set up again, scan to continue');
    expect(REINSTALLED).toBe('Your computer was set up again, scan to continue');
    await expect(c.seal(AGENT, 'hi')).rejects.toEqual(new SealError('pair_again'));
    expect((await loadTrusted(store)).map((d) => d.id)).toEqual([computerA.id]);
  });

  it('never shows the reinstall banner for a computer that was only revoked', async () => {
    const store = await phoneWithKey();
    await saveTrusted(store, [trusted(computerA, CON_A)]);
    const c = chats(store, [listed(computerA, { revoked_at: '2026-11-25T00:00:00.000Z' })]);
    await c.context(AGENT);
    expect(c.notice(AGENT)).toBe(PAIR_AGAIN);
    expect(await loadTrusted(store)).toEqual([]);
  });

  it('says nothing while the computer is trusted and listed', async () => {
    const store = await phoneWithKey();
    await saveTrusted(store, [trusted(computerA, CON_A)]);
    const c = chats(store, [listed(computerA)]);
    await c.context(AGENT);
    expect(c.notice(AGENT)).toBeUndefined();
    await expect(c.seal(AGENT, 'hi')).resolves.toBeDefined();
  });

  it('keeps working offline: an unreadable list changes nothing', async () => {
    const store = await phoneWithKey();
    await saveTrusted(store, [trusted(computerA, CON_A)]);
    const c = new PrivateChats({
      store,
      replay: {
        load: () => Promise.resolve({}),
        save: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      addressOf: () => Promise.resolve(`cord-connector://${CON_A}/${AGENT}`),
      devices: () => Promise.reject(new Error('offline')),
    });
    await c.context(AGENT);
    expect(c.notice(AGENT)).toBeUndefined();
  });
});

describe('lost keys (a reinstalled app)', () => {
  it('lost keys without recovery say so plainly', async () => {
    expect(lostKeyMessage()).toBe(
      "Older private messages can't be opened on this phone. New messages will work after you pair.",
    );
    // A new phone key: the chat's messages were all sealed for the old one.
    const store = memoryStore();
    const c = chats(store, undefined);
    await c.context(AGENT);
    const old = keys();
    const key = newMessageKey();
    const aad = messageAad({
      accountId: CON_A,
      agentId: AGENT,
      senderDevice: computerA.id,
      senderSeq: 1,
    });
    const { nonce, body } = sealBody(key, { text: 'x' }, aad);
    c.open(AGENT, [
      msg({
        v: 1,
        sender_device: computerA.id,
        sender_seq: 1,
        nonce,
        body,
        keys: [{ device: old.id, wrapped: wrapKey(key, computerA.privateKey, old.publicKey, aad) }],
      }),
    ]);
    expect(c.notice(AGENT)).toBe(LOST_KEYS);
  });
});

describe('one computer per agent (from the #148 verification)', () => {
  it('binding refuses a reply from another trusted computer', () => {
    const ctx = ctxWith([trusted(computerA, CON_A), trusted(computerB, CON_B)]);
    const [fromB] = openMessages(ctx, [msg(replyFrom(computerB))]);
    expect(fromB.state).toBe('couldnt_open');
    const [fromA] = openMessages(ctx, [msg(replyFrom(computerA))]);
    expect(fromA.state).toBe('ok');
  });

  it('an older entry with no connector id keeps working while no computer is bound to the chat', () => {
    const ctx = ctxWith([trusted(computerA)]);
    expect(openMessages(ctx, [msg(replyFrom(computerA))])[0].state).toBe('ok');
  });

  it('an older unbound entry cannot speak in a chat whose computer is bound', () => {
    const ctx = ctxWith([trusted(computerA, CON_A), trusted(computerB)]);
    expect(openMessages(ctx, [msg(replyFrom(computerB))])[0].state).toBe('couldnt_open');
  });

  it('an older entry is bound when the phone reads the device list', async () => {
    const store = await phoneWithKey();
    await saveTrusted(store, [trusted(computerA)]);
    const c = chats(store, [listed(computerA)]);
    await c.context(AGENT);
    expect((await loadTrusted(store))[0].connector_id).toBe(CON_A);
  });
});
