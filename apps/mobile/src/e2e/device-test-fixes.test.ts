import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  messageAad,
  newMessageKey,
  sealBody,
  wrapKey,
  type E2eDevice,
  type RecoveryBackupRequest,
  type SealedEnvelopeV1,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { DEVICE_KEY_NAME, loadDeviceKey } from './device-key';
import {
  NEW_PHONE,
  noticeAction,
  REINSTALLED,
  REMOVED_PHONE,
  SET_UP_PHONE,
  PAIR_AGAIN_ACTION,
} from './devices';
import { loadTrusted, saveTrusted, type TrustedDevice } from './pairing';
import { PrivateChats, REMOVED_CHECK_MS, SealError, SENDER_LOOKUP_MS } from './private-chats';
import { PAIR_AGAIN } from './private-state';
import { REWRAP_JOBS_KEY } from './rewrap';
import {
  newRecoveryWords,
  restoreFromWords,
  restoreOffer,
  saveRecoveryKey,
  type RecoveryApi,
} from './recovery';
import type { SealedThreadMessage } from './sealed-thread';
import { memoryStore } from './test-fixtures';

/** Found in the two-phone staging test on 2026-11-26 (C3 #11 P4). */

const CON = `con_${'a'.repeat(20)}`;
const AGENT = 'claude-code';
const ACCOUNT = 'hosted_u1';
const at = '2026-11-20T10:00:00.000Z';

const keys = () => {
  const pair = generateSealKeyPair();
  return { ...pair, id: deviceIdFor(pair.publicKey), pub: base64urlEncode(pair.publicKey) };
};
const computer = keys();
const phone = keys();

const trustedComputer = (k = computer): TrustedDevice => ({
  id: k.id,
  kind: 'computer',
  name: 'Laptop',
  public_key: k.pub,
  verified_at: at,
  connector_id: CON,
});
const listed = (k: ReturnType<typeof keys>, extra: Partial<E2eDevice> = {}): E2eDevice => ({
  id: k.id,
  kind: 'computer',
  name: 'Laptop',
  public_key: k.pub,
  added_at: at,
  connector_id: CON,
  ...extra,
});
const listedPhone = (id: string, extra: Partial<E2eDevice> = {}): E2eDevice => ({
  id,
  kind: 'phone',
  name: 'Phone',
  public_key: phone.pub,
  added_at: at,
  ...extra,
});

function chats(store: ReturnType<typeof memoryStore>, devices: () => unknown) {
  return new PrivateChats({
    store,
    replay: {
      load: () => Promise.resolve({}),
      save: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
    addressOf: () => Promise.resolve(`cord-connector://${CON}/${AGENT}`),
    devices: () => Promise.resolve(devices()),
  });
}

async function storeWithPhoneKey() {
  const store = memoryStore();
  await store.setItemAsync(
    DEVICE_KEY_NAME,
    JSON.stringify({ v: 1, public_key: phone.pub, private_key: base64urlEncode(phone.privateKey) }),
  );
  return store;
}

function replyTo(to: ReturnType<typeof keys>): SealedThreadMessage {
  const key = newMessageKey();
  const aad = messageAad({
    accountId: CON,
    agentId: AGENT,
    senderDevice: computer.id,
    senderSeq: 1,
  });
  const { nonce, body } = sealBody(key, { text: 'older hello' }, aad);
  const sealed: SealedEnvelopeV1 = {
    v: 1,
    sender_device: computer.id,
    sender_seq: 1,
    nonce,
    body,
    keys: [{ device: to.id, wrapped: wrapKey(key, computer.privateKey, to.publicKey, aad) }],
  };
  return {
    id: `msg_${'a'.repeat(20)}`,
    kind: 'sealed',
    author: 'agent',
    sealed: [sealed],
  } as unknown as SealedThreadMessage;
}

describe('a new phone (bug 1)', () => {
  it('a phone that trusts no computer is told to set up, not that the computer was reinstalled', async () => {
    const store = memoryStore();
    const c = chats(store, () => ({ devices: [listed(computer)] }));
    await c.context(AGENT);
    expect(c.notice(AGENT)).toBe(NEW_PHONE);
    expect(noticeAction(NEW_PHONE)).toBe(SET_UP_PHONE);
  });

  // Staging re-test: restored with a recovery key saved before the computer got a new key, the
  // phone's list had already lost that computer, and it was told it was new.
  it('a phone the server already lists is told to pair its computer again, never that it is new', async () => {
    const store = await storeWithPhoneKey();
    const newComputer = keys();
    const c = chats(store, () => ({
      devices: [listedPhone(phone.id), listed(computer, { revoked_at: at }), listed(newComputer)],
    }));
    await c.context(AGENT);
    expect(await loadTrusted(store)).toEqual([]);
    expect(c.notice(AGENT)).toBe(PAIR_AGAIN);
    expect(noticeAction(PAIR_AGAIN)).toBe(PAIR_AGAIN_ACTION);
    // Opened again later (an app restart, or after a pairing elsewhere): still not a new phone.
    c.reset();
    await c.context(AGENT);
    expect(c.notice(AGENT)).toBe(PAIR_AGAIN);
  });

  it('a phone that trusted the old computer still sees the reinstalled notice', async () => {
    const store = await storeWithPhoneKey();
    await saveTrusted(store, [trustedComputer()]);
    const c = chats(store, () => ({
      devices: [listedPhone(phone.id), listed(computer, { revoked_at: at }), listed(keys())],
    }));
    await c.context(AGENT);
    expect(c.notice(AGENT)).toBe(REINSTALLED);
    expect(noticeAction(REINSTALLED)).toBe(PAIR_AGAIN_ACTION);
  });
});

describe('restoring on a wiped phone (bug 2)', () => {
  function recoveryServer() {
    let saved: RecoveryBackupRequest | undefined;
    const api: RecoveryApi = {
      put: (body) => {
        saved = body;
        return Promise.resolve({ status: 200, body: { updated_at: at } });
      },
      get: () =>
        Promise.resolve(
          saved === undefined
            ? { status: 404, body: {} }
            : { status: 200, body: { ...saved, updated_at: at, device_removed: false } },
        ),
      remove: () => Promise.resolve({ status: 204, body: undefined }),
    };
    return api;
  }

  it('offers the recovery key after opening a chat made a key, and the chat opens older messages', async () => {
    const api = recoveryServer();
    const old = await storeWithPhoneKey();
    await saveTrusted(old, [trustedComputer()]);
    const words = newRecoveryWords();
    expect(await saveRecoveryKey({ api, store: old, account: ACCOUNT }, words)).toEqual({
      ok: true,
    });

    // The wiped phone: same account, empty keychain.
    const store = memoryStore();
    const server = () => ({ devices: [listedPhone(phone.id), listed(computer)] });
    const devices = { list: () => Promise.resolve(server()) };
    const c = chats(store, server);
    await c.context(AGENT);
    const fresh = await loadDeviceKey(store);
    expect(fresh?.deviceId).not.toBe(phone.id);

    const offer = await restoreOffer({ api, store, devices });
    expect(offer.kind).toBe('found');
    if (offer.kind !== 'found') return;
    const restored = await restoreFromWords(
      { api, store, account: ACCOUNT, devices },
      offer.backup,
      words.join(' '),
    );
    expect(restored).toEqual({ ok: true, deviceId: phone.id });

    c.reset();
    await c.context(AGENT);
    const opened = c.open(AGENT, [replyTo(phone)]);
    expect(opened?.map((m) => m.state)).toEqual(['ok']);
    expect(c.notice(AGENT)).toBeUndefined();
  });

  it('never replaces a key the server lists or this phone trusts with', async () => {
    const api = recoveryServer();
    await saveRecoveryKey(
      { api, store: await storeWithPhoneKey(), account: ACCOUNT },
      newRecoveryWords(),
    );
    const listedStore = memoryStore();
    const c = chats(listedStore, () => ({ devices: [] }));
    await c.context(AGENT);
    const mine = (await loadDeviceKey(listedStore))!.deviceId;
    const devices = { list: () => Promise.resolve({ devices: [listedPhone(mine)] }) };
    expect((await restoreOffer({ api, store: listedStore, devices })).kind).toBe('none');

    const trustingStore = memoryStore();
    await chats(trustingStore, () => ({ devices: [] })).context(AGENT);
    await saveTrusted(trustingStore, [trustedComputer()]);
    const none = { list: () => Promise.resolve({ devices: [] }) };
    expect((await restoreOffer({ api, store: trustingStore, devices: none })).kind).toBe('none');
    // Without the server's list the key counts as used.
    expect((await restoreOffer({ api, store: listedStore })).kind).toBe('none');
  });
});

describe('a removed phone (bug 3)', () => {
  async function pairedPhone() {
    const store = await storeWithPhoneKey();
    await saveTrusted(store, [trustedComputer()]);
    return store;
  }

  it('forgets its keys, says so, and refuses to send', async () => {
    const store = await pairedPhone();
    const c = chats(store, () => ({
      devices: [listedPhone(phone.id, { revoked_at: at }), listed(computer)],
    }));
    await c.context(AGENT);
    expect(c.notice(AGENT)).toBe(REMOVED_PHONE);
    expect(noticeAction(REMOVED_PHONE)).toBe(SET_UP_PHONE);
    expect(await loadDeviceKey(store)).toBeUndefined();
    expect(await loadTrusted(store)).toEqual([]);
    await expect(c.seal(AGENT, 'hi')).rejects.toEqual(new SealError('pair_again'));
  });

  it('wipes what Remove this phone wipes and tells the chats (R3-4)', async () => {
    const store = await pairedPhone();
    await store.setItemAsync(REWRAP_JOBS_KEY, '[]');
    let replayRemoved = 0;
    let told = 0;
    const c = new PrivateChats({
      store,
      replay: {
        load: () => Promise.resolve({}),
        save: () => Promise.resolve(),
        remove: () => Promise.resolve(void replayRemoved++),
      },
      addressOf: () => Promise.resolve(`cord-connector://${CON}/${AGENT}`),
      devices: () =>
        Promise.resolve({
          devices: [listedPhone(phone.id, { revoked_at: at }), listed(computer)],
        }),
    });
    c.onRemoved(() => void told++);
    await c.context(AGENT);
    expect(replayRemoved).toBe(1);
    expect(told).toBe(1);
    expect(await store.getItemAsync(REWRAP_JOBS_KEY)).toBeNull();
  });

  it('removed over 30 days ago or left out by mistake: missing from the list keeps its keys', async () => {
    const store = await pairedPhone();
    const c = chats(store, () => ({ devices: [listed(computer)] }));
    await c.context(AGENT);
    expect(c.notice(AGENT)).not.toBe(REMOVED_PHONE);
    expect((await loadDeviceKey(store))?.deviceId).toBe(phone.id);
    expect(await loadTrusted(store)).toHaveLength(1);
  });

  it('offline or a bad answer changes nothing', async () => {
    for (const answer of [
      () => {
        throw new Error('offline');
      },
      () => ({ nope: true }),
    ]) {
      const store = await pairedPhone();
      const c = chats(store, answer);
      await c.context(AGENT);
      expect(c.notice(AGENT)).toBeUndefined();
      expect((await loadDeviceKey(store))?.deviceId).toBe(phone.id);
      expect(await loadTrusted(store)).toHaveLength(1);
    }
  });
});

describe('a phone removed while its chat is open (finding 14)', () => {
  async function loaded(revoked: () => boolean) {
    const store = await storeWithPhoneKey();
    await saveTrusted(store, [trustedComputer()]);
    let calls = 0;
    const c = chats(store, () => {
      calls++;
      return {
        devices: [listedPhone(phone.id, revoked() ? { revoked_at: at } : {}), listed(computer)],
      };
    });
    await c.context(AGENT);
    return { store, c, calls: () => calls };
  }
  const other = keys();
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('a reply with no key for this phone reads the list, shows removed and makes no new key', async () => {
    let revoked = false;
    const { store, c, calls } = await loaded(() => revoked);
    expect(calls()).toBe(1);
    revoked = true;
    let told = 0;
    c.onRemoved(() => void told++);
    c.open(AGENT, [replyTo(other)]);
    await settle();
    await settle();
    expect(calls()).toBe(2);
    expect(told).toBe(1);
    expect(c.removed()).toBe(true);
    expect(c.removedSince()).toBe(at);
    expect(c.notice(AGENT)).toBe(REMOVED_PHONE);
    await expect(c.seal(AGENT, 'hi')).rejects.toEqual(new SealError('pair_again'));
    expect(await c.context(AGENT)).toBeUndefined();
    expect(await loadDeviceKey(store)).toBeUndefined();
  });

  it('a second keyless reply inside 30 s reads nothing more; a reset clears the wait', async () => {
    const { c, calls } = await loaded(() => false);
    c.open(AGENT, [replyTo(other)]);
    await settle();
    c.open(AGENT, [replyTo(other)]);
    await c.checkRemoved(AGENT);
    expect(calls()).toBe(2);
    c.reset();
    await c.context(AGENT);
    expect(calls()).toBe(3);
    await c.checkRemoved(AGENT);
    expect(calls()).toBe(4);
  });

  it('a phone the server still trusts keeps its key and its chat', async () => {
    const { store, c } = await loaded(() => false);
    c.open(AGENT, [replyTo(other)]);
    await settle();
    expect(c.removed()).toBe(false);
    expect(c.notice(AGENT)).not.toBe(REMOVED_PHONE);
    expect((await loadDeviceKey(store))?.deviceId).toBe(phone.id);
    expect(c.open(AGENT, [replyTo(phone)])?.map((m) => m.state)).toEqual(['ok']);
  });
});

describe('edge cases (verifier)', () => {
  async function pairedPhone() {
    const store = await storeWithPhoneKey();
    await saveTrusted(store, [trustedComputer()]);
    return store;
  }
  const replay = {
    load: () => Promise.resolve({}),
    save: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };

  it('a reset while a context load is in flight never keeps the stale context', async () => {
    const store = await pairedPhone();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const c = new PrivateChats({
      store,
      replay,
      addressOf: () => Promise.resolve(`cord-connector://${CON}/${AGENT}`),
      devices: async () => {
        calls++;
        if (calls === 1) await gate;
        return { devices: [listedPhone(phone.id), listed(computer)] };
      },
    });
    const stale = c.context(AGENT);
    await new Promise((r) => setTimeout(r, 0));
    // A restore put a different key in the keychain, then reset the chats.
    const other = keys();
    await store.setItemAsync(
      DEVICE_KEY_NAME,
      JSON.stringify({
        v: 1,
        public_key: other.pub,
        private_key: base64urlEncode(other.privateKey),
      }),
    );
    c.reset();
    const fresh = c.context(AGENT);
    release();
    await stale;
    const ctx = await fresh;
    expect(ctx?.me.deviceId).toBe(other.id);
    expect(c.ready(AGENT)?.me.deviceId).toBe(other.id);
  });

  it('a send racing the load that finds the phone removed is refused', async () => {
    const store = await pairedPhone();
    const c = chats(store, () => ({
      devices: [listedPhone(phone.id, { revoked_at: at }), listed(computer)],
    }));
    const [, sent] = await Promise.allSettled([c.context(AGENT), c.seal(AGENT, 'hi')]);
    expect(sent.status).toBe('rejected');
    expect(c.notice(AGENT)).toBe(REMOVED_PHONE);
    expect(await loadDeviceKey(store)).toBeUndefined();
  });

  it('a phone whose only computer was removed says pair again, not the new-phone notice', async () => {
    const store = await pairedPhone();
    const c = chats(store, () => ({
      devices: [listedPhone(phone.id), listed(computer, { revoked_at: at })],
    }));
    await c.context(AGENT);
    expect(await loadTrusted(store)).toEqual([]);
    const notice = c.notice(AGENT);
    expect(notice).toBeDefined();
    expect(notice).not.toBe(NEW_PHONE);
    expect(noticeAction(notice!)).toBe(PAIR_AGAIN_ACTION);
  });

  it('after the removed notice, a rebuilt context still refuses to send', async () => {
    const store = await pairedPhone();
    const c = chats(store, () => ({
      devices: [listedPhone(phone.id, { revoked_at: at }), listed(computer)],
    }));
    await c.context(AGENT);
    await expect(c.seal(AGENT, 'hi')).rejects.toEqual(new SealError('pair_again'));
    c.reset();
    await c.context(AGENT);
    // A new key that trusts nothing: told to set up, and nothing is sealed.
    expect(c.notice(AGENT)).toBe(NEW_PHONE);
    await expect(c.seal(AGENT, 'hi')).rejects.toBeInstanceOf(SealError);
  });

  it('keyInUse counts a failed or malformed device list as in use', async () => {
    const { keyInUse } = await import('./recovery');
    const store = memoryStore();
    await chats(store, () => ({ devices: [] })).context(AGENT);
    const list = (answer: () => Promise<unknown>) => ({ store, devices: { list: answer } });
    expect(await keyInUse(list(() => Promise.reject(new Error('offline'))))).toBe(true);
    expect(await keyInUse(list(() => Promise.resolve({ bad: 1 })))).toBe(true);
    expect(await keyInUse(list(() => Promise.resolve({ devices: 'nope' })))).toBe(true);
    expect(await keyInUse(list(() => Promise.resolve({ devices: [] })))).toBe(false);
  });

  it('logs carry no key material', async () => {
    const lines: string[] = [];
    const store = await pairedPhone();
    const c = new PrivateChats({
      store,
      replay,
      addressOf: () => Promise.resolve(`cord-connector://${CON}/${AGENT}`),
      devices: () =>
        Promise.resolve({
          devices: [listedPhone(phone.id, { revoked_at: at }), listed(computer)],
        }),
      log: (e, f) => lines.push(JSON.stringify([e, f])),
    });
    await c.context(AGENT);
    expect(lines.join('\n')).not.toContain(base64urlEncode(phone.privateKey));
  });
});

describe('a phone approved after the chat loaded (device test 2026-11-27)', () => {
  const newPhone = keys();
  const trustedPhone: TrustedDevice = {
    id: newPhone.id,
    kind: 'phone',
    name: 'Moto',
    public_key: newPhone.pub,
    verified_at: at,
  };
  const listedNew = (): E2eDevice => ({
    id: newPhone.id,
    kind: 'phone',
    name: 'Moto',
    public_key: newPhone.pub,
    added_at: at,
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  function fromPhone(from: ReturnType<typeof keys>, seq: number): SealedThreadMessage {
    const key = newMessageKey();
    const aad = messageAad({
      accountId: CON,
      agentId: AGENT,
      senderDevice: from.id,
      senderSeq: seq,
    });
    const { nonce, body } = sealBody(key, { text: `back ${seq}` }, aad);
    return {
      id: `msg_${String(seq).padStart(20, 'b')}`,
      kind: 'sealed',
      author: 'user',
      sealed: [
        {
          v: 1,
          sender_device: from.id,
          sender_seq: seq,
          nonce,
          body,
          keys: [
            { device: phone.id, wrapped: wrapKey(key, from.privateKey, phone.publicKey, aad) },
          ],
        },
      ],
    } as unknown as SealedThreadMessage;
  }

  async function loaded(server: () => E2eDevice[]) {
    const store = await storeWithPhoneKey();
    await saveTrusted(store, [trustedComputer()]);
    let calls = 0;
    const c = chats(store, () => {
      calls++;
      return { devices: server() };
    });
    await c.context(AGENT);
    return { store, c, calls: () => calls };
  }

  it('opens after a reset once this phone trusts the new one', async () => {
    let listNew = false;
    const { store, c } = await loaded(() => [
      listedPhone(phone.id),
      listed(computer),
      ...(listNew ? [listedNew()] : []),
    ]);
    await saveTrusted(store, [trustedComputer(), trustedPhone]);
    listNew = true;
    c.reset();
    await c.context(AGENT);
    const opened = c.open(AGENT, [fromPhone(newPhone, 1)]);
    expect(opened?.map((m) => [m.state, m.state === 'ok' && m.author])).toEqual([['ok', 'user']]);
  });

  it('opens without a reset: the chat reads the trusted list again once', async () => {
    const { store, c, calls } = await loaded(() => [listedPhone(phone.id), listed(computer)]);
    await saveTrusted(store, [trustedComputer(), trustedPhone]);
    const messages = [fromPhone(newPhone, 1), fromPhone(newPhone, 2)];
    // Waiting for the list: the chat shows loading, never a stale "Couldn't open".
    expect(c.open(AGENT, messages)).toBeUndefined();
    await c.context(AGENT);
    expect(c.open(AGENT, messages)?.map((m) => m.state)).toEqual(['ok', 'ok']);
    // The keychain knew it: the server's list was not read again.
    expect(calls()).toBe(1);
  });

  it('a sender no list trusts still cannot open, and is looked up once per 30 s', async () => {
    const { c, calls } = await loaded(() => [listedPhone(phone.id), listed(computer)]);
    const stranger = keys();
    const messages = [fromPhone(stranger, 1), fromPhone(stranger, 2), fromPhone(stranger, 3)];
    expect(c.open(AGENT, messages)).toBeUndefined();
    await c.context(AGENT);
    expect(calls()).toBe(2);
    expect(c.open(AGENT, messages)?.map((m) => m.state)).toEqual([
      'couldnt_open',
      'couldnt_open',
      'couldnt_open',
    ]);
    // Opening again (each new message) reads nothing more inside the window.
    c.open(AGENT, [...messages]);
    await settle();
    expect(calls()).toBe(2);
  });

  it('a stalled lookup stops holding the chat on loading after a deadline', async () => {
    let stall = false;
    const { c } = await loaded(() =>
      stall
        ? (new Promise(() => undefined) as unknown as E2eDevice[])
        : [listedPhone(phone.id), listed(computer)],
    );
    stall = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const messages = [fromPhone(keys(), 1)];
      expect(c.open(AGENT, messages)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(SENDER_LOOKUP_MS);
      expect(c.open(AGENT, messages)?.map((m) => m.state)).toEqual(['couldnt_open']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a sender the server list does not know is not looked up again (combined review)', async () => {
    const { c, calls } = await loaded(() => [listedPhone(phone.id), listed(computer)]);
    const stranger = keys();
    expect(c.open(AGENT, [fromPhone(stranger, 1)])).toBeUndefined();
    await c.context(AGENT);
    expect(calls()).toBe(2);
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * REMOVED_CHECK_MS);
    try {
      // A removed phone or this phone before a reinstall: the chat opens at once, no new read.
      const messages = [fromPhone(stranger, 1), fromPhone(stranger, 2)];
      expect(c.open(AGENT, messages)?.map((m) => m.state)).toEqual([
        'couldnt_open',
        'couldnt_open',
      ]);
      await settle();
      expect(calls()).toBe(2);
    } finally {
      later.mockRestore();
    }
  });

  it('a lookup that could not read the list tries again after 30 s', async () => {
    let offline = false;
    const { c, calls } = await loaded(() => {
      if (offline) throw new Error('offline');
      return [listedPhone(phone.id), listed(computer)];
    });
    offline = true;
    const stranger = keys();
    expect(c.open(AGENT, [fromPhone(stranger, 1)])).toBeUndefined();
    await c.context(AGENT);
    const tried = calls();
    offline = false;
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + REMOVED_CHECK_MS + 1);
    try {
      expect(c.open(AGENT, [fromPhone(stranger, 1)])).toBeUndefined();
      await c.context(AGENT);
      expect(calls()).toBe(tried + 1);
    } finally {
      later.mockRestore();
    }
  });

  it('a sender the server removed is not trusted again by the lookup', async () => {
    const { store, c } = await loaded(() => [
      listedPhone(phone.id),
      listed(computer),
      { ...listedNew(), revoked_at: at },
    ]);
    expect(c.open(AGENT, [fromPhone(newPhone, 1)])).toBeUndefined();
    await c.context(AGENT);
    expect(c.open(AGENT, [fromPhone(newPhone, 1)])?.map((m) => m.state)).toEqual(['couldnt_open']);
    expect((await loadTrusted(store)).some((d) => d.id === newPhone.id)).toBe(false);
  });
});

describe('a trusted list changed elsewhere reaches loaded chats (stale audit 0)', () => {
  const otherPhone = keys();
  const trustedOther: TrustedDevice = {
    id: otherPhone.id,
    kind: 'phone',
    name: 'Moto',
    public_key: otherPhone.pub,
    verified_at: at,
  };
  const listedOther = (extra: Partial<E2eDevice> = {}): E2eDevice => ({
    id: otherPhone.id,
    kind: 'phone',
    name: 'Moto',
    public_key: otherPhone.pub,
    added_at: at,
    ...extra,
  });

  async function loaded(server: () => E2eDevice[]) {
    const store = await storeWithPhoneKey();
    await saveTrusted(store, [trustedComputer(), trustedOther]);
    const c = chats(store, () => ({ devices: server() }));
    await c.context(AGENT);
    const told: string[][] = [];
    c.onTrustedChanged((ids) => told.push(ids));
    return { c, told };
  }

  it('a phone removed on another phone stops being trusted in the open chat at once', async () => {
    let removed = false;
    const { c, told } = await loaded(() => [
      listedPhone(phone.id),
      listed(computer),
      listedOther(removed ? { revoked_at: at } : {}),
    ]);
    removed = true;
    await c.checkRemoved(AGENT);
    expect(told).toEqual([[AGENT]]);
    const ctx = await c.context(AGENT);
    expect(ctx?.trusted.some((d) => d.id === otherPhone.id)).toBe(false);
  });

  it('a computer reinstalled meanwhile shows its notice and tells the chats', async () => {
    let reinstalled = false;
    const { c, told } = await loaded(() =>
      reinstalled
        ? [
            listedPhone(phone.id),
            listed(computer, { revoked_at: at }),
            listed(keys()),
            listedOther(),
          ]
        : [listedPhone(phone.id), listed(computer), listedOther()],
    );
    expect(c.notice(AGENT)).toBeUndefined();
    reinstalled = true;
    await c.checkRemoved(AGENT);
    expect(told).toEqual([[AGENT]]);
    expect(c.notice(AGENT)).toBe(REINSTALLED);
  });

  it('an unchanged list tells nobody', async () => {
    const { c, told } = await loaded(() => [
      listedPhone(phone.id),
      listed(computer),
      listedOther(),
    ]);
    await c.checkRemoved(AGENT);
    expect(told).toEqual([]);
  });
});
