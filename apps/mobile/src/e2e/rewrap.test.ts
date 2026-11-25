/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access -- fake server answers in tests. */
import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  messageAad,
  newMessageKey,
  sealBody,
  wrapKey,
  type SealedEnvelopeV1,
  type SealedKeysUpload,
  type ThreadMessage,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { DEVICE_KEY_NAME, loadOrCreateDeviceKey, type DeviceKey } from './device-key';
import { LOST_KEYS } from './devices';
import { saveTrusted, type TrustedDevice } from './pairing';
import { PrivateChats } from './private-chats';
import { PAIR_AGAIN } from './private-state';
import {
  hasRewrapWork,
  queueRewrap,
  readRewraps,
  REWRAP_JOBS_KEY,
  runRewrapJobs,
  type RewrapDeps,
} from './rewrap';
import {
  createPhoneContext,
  openMessage,
  type Rewrap,
  type SealedThreadMessage,
} from './sealed-thread';
import { memoryStore } from './test-fixtures';

const ACCOUNT = 'con_' + 'a'.repeat(20);
const AGENT = 'claude';
const ADDRESS = `cord-connector://${ACCOUNT}/${AGENT}`;
const AGENT_ID = 'agt_' + 'a'.repeat(20);
const computer = generateSealKeyPair();
const newPhone = generateSealKeyPair();
const stranger = generateSealKeyPair();
const COMPUTER_ID = deviceIdFor(computer.publicKey);
const NEW_ID = deviceIdFor(newPhone.publicKey);

const device = (
  kind: 'phone' | 'computer',
  publicKey: Uint8Array,
  extra: Partial<TrustedDevice> = {},
): TrustedDevice => ({
  id: deviceIdFor(publicKey),
  kind,
  name: kind === 'phone' ? 'Phone' : 'Computer',
  public_key: base64urlEncode(publicKey),
  verified_at: '2026-11-25T00:00:00.000Z',
  ...(kind === 'computer' && { connector_id: ACCOUNT }),
  ...extra,
});

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const msgId = (n: number) => {
  let out = '';
  for (let v = n, i = 0; i < 20; i++, v = Math.floor(v / 32)) out = B32[v % 32] + out;
  return 'msg_' + out;
};

/** A computer reply to `to` (and nobody else), optionally in chunks sharing one key. */
function reply(
  n: number,
  to: Uint8Array[],
  texts: string[] = [`reply ${n}`],
  chunked = texts.length > 1,
): SealedThreadMessage {
  const key = newMessageKey();
  const sealed: SealedEnvelopeV1[] = texts.map((text, index) => {
    const chunk = chunked ? { index, final: index === texts.length - 1 } : undefined;
    const aad = messageAad({
      accountId: ACCOUNT,
      agentId: AGENT,
      senderDevice: COMPUTER_ID,
      senderSeq: n,
      ...(chunk !== undefined && { chunk: chunk.index }),
    });
    const { nonce, body } = sealBody(key, { text }, aad);
    return {
      v: 1,
      sender_device: COMPUTER_ID,
      sender_seq: n,
      nonce,
      body,
      keys: to.map((pub) => ({
        device: deviceIdFor(pub),
        wrapped: wrapKey(key, computer.privateKey, pub, aad),
      })),
      ...(chunk !== undefined && { chunk }),
    };
  });
  return {
    id: msgId(n),
    kind: 'sealed',
    author: 'agent',
    seq: n,
    sealed,
  } as unknown as SealedThreadMessage;
}

async function approvingPhone() {
  const store = memoryStore();
  const me = await loadOrCreateDeviceKey(store);
  // The approve step trusts the new phone (`approveWaiting`).
  await saveTrusted(store, [
    device('computer', computer.publicKey),
    device('phone', newPhone.publicKey),
  ]);
  return { store, me };
}

function deps(
  store: ReturnType<typeof memoryStore>,
  history: ThreadMessage[],
  upload: RewrapDeps['api']['upload'],
): RewrapDeps {
  // Newest first below `beforeSeq`, two per page, like the server's `before_seq`.
  return {
    store,
    api: { upload },
    privateChats: () => Promise.resolve([{ agentId: AGENT_ID, address: ADDRESS }]),
    messages: (_agent, before) => {
      const below = history
        .filter((m) => before === undefined || m.seq < before)
        .sort((a, b) => b.seq - a.seq);
      return Promise.resolve({ messages: below.slice(0, 100), hasMore: below.length > 100 });
    },
  };
}

function newPhoneCtx(trusted: TrustedDevice[], rewraps: Map<string, Rewrap>) {
  return createPhoneContext({
    accountId: ACCOUNT,
    agentId: AGENT,
    me: { deviceId: NEW_ID, publicKey: newPhone.publicKey, privateKey: newPhone.privateKey },
    trusted,
    nextSeq: () => 1,
    rewraps,
  });
}

describe('re-wrapping older private messages for an approved phone (C3 #11, Task 28)', () => {
  it('resumes from the last done cursor after a restart, with no duplicates', async () => {
    const { store, me } = await approvingPhone();
    const history = Array.from({ length: 450 }, (_, i) => reply(i + 1, [me.publicKey]));
    await queueRewrap(store, { id: NEW_ID, public_key: base64urlEncode(newPhone.publicKey) });
    const sent: string[] = [];
    let calls = 0;
    // The first run dies after its first batch was stored (the app was closed).
    const crashing = vi.fn(async (_agent: string, body: SealedKeysUpload) => {
      calls++;
      if (calls === 2) throw new Error('app closed');
      sent.push(...body.items.map((i) => i.message_id));
      expect(body.items.length).toBeLessThanOrEqual(200);
      expect(body).toMatchObject({ device_id: me.deviceId, for: NEW_ID });
      return { status: 204, body: undefined };
    });
    await runRewrapJobs(deps(store, history, crashing));
    expect(sent).toHaveLength(200);
    const resumed = vi.fn(async (_agent: string, body: SealedKeysUpload) => {
      sent.push(...body.items.map((i) => i.message_id));
      return { status: 204, body: undefined };
    });
    await runRewrapJobs(deps(store, history, resumed));
    expect(sent).toHaveLength(450);
    expect(new Set(sent).size).toBe(450);
    // Finished: the job is gone, so the next open does nothing.
    expect(JSON.parse(store.m.get(REWRAP_JOBS_KEY)!)).toEqual([]);
    const again = vi.fn();
    await runRewrapJobs(deps(store, history, again));
    expect(again).not.toHaveBeenCalled();
  });

  it('stops for good on 409 unknown_device', async () => {
    const { store, me } = await approvingPhone();
    const history = Array.from({ length: 300 }, (_, i) => reply(i + 1, [me.publicKey]));
    await queueRewrap(store, { id: NEW_ID, public_key: base64urlEncode(newPhone.publicKey) });
    const gone = vi.fn(async () => ({
      status: 409,
      body: { error: { code: 'unknown_device' } },
    }));
    await runRewrapJobs(deps(store, history, gone));
    await runRewrapJobs(deps(store, history, gone));
    expect(gone).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.m.get(REWRAP_JOBS_KEY)!)[0]).toMatchObject({ stopped: true });
  });

  it('skips messages it cannot open and re-wraps chunked replies correctly', async () => {
    const { store, me } = await approvingPhone();
    const chunked = reply(1, [me.publicKey], ['Hello, ', 'world', '!']);
    const notMine = reply(2, [stranger.publicKey]);
    const plain = reply(3, [me.publicKey]);
    await queueRewrap(store, { id: NEW_ID, public_key: base64urlEncode(newPhone.publicKey) });
    let items: SealedKeysUpload['items'] = [];
    await runRewrapJobs(
      deps(store, [chunked, notMine, plain], async (_a, body) => {
        items = body.items;
        return { status: 204, body: undefined };
      }),
    );
    expect(items.map((i) => i.message_id).sort()).toEqual([chunked.id, plain.id].sort());
    const ctx = newPhoneCtx(
      [device('computer', computer.publicKey), device('phone', me.publicKey)],
      new Map(items.map((i) => [i.message_id, { by: me.deviceId, wrapped: i.wrapped }])),
    );
    expect(openMessage(ctx, chunked)).toMatchObject({ state: 'ok', text: 'Hello, world!' });
    expect(openMessage(ctx, plain)).toMatchObject({ state: 'ok', text: 'reply 3' });
  });
});

describe('the new phone opening re-wraps', () => {
  async function setup() {
    const { store, me } = await approvingPhone();
    const old = reply(7, [me.publicKey]);
    const other = reply(8, [me.publicKey]);
    await queueRewrap(store, { id: NEW_ID, public_key: base64urlEncode(newPhone.publicKey) });
    const items = new Map<string, string>();
    await runRewrapJobs(
      deps(store, [old, other], async (_a, body) => {
        for (const i of body.items) items.set(i.message_id, i.wrapped);
        return { status: 204, body: undefined };
      }),
    );
    return { me, old, other, items };
  }
  const trustedPhone = (me: DeviceKey) => device('phone', me.publicKey);

  it('opens an old message through a re-wrap from a trusted phone', async () => {
    const { me, old, items } = await setup();
    const ctx = newPhoneCtx(
      [device('computer', computer.publicKey), trustedPhone(me)],
      new Map([[old.id, { by: me.deviceId, wrapped: items.get(old.id)! }]]),
    );
    expect(openMessage(ctx, old)).toMatchObject({ state: 'ok', text: 'reply 7' });
  });

  it('refuses a re-wrap whose by is a computer or an untrusted device', async () => {
    const { me, old, items } = await setup();
    const wrapped = items.get(old.id)!;
    // The same key, claimed by the computer (a phone the server lists as a computer).
    const asComputer = newPhoneCtx(
      [device('computer', computer.publicKey), device('computer', me.publicKey)],
      new Map([[old.id, { by: me.deviceId, wrapped }]]),
    );
    expect(openMessage(asComputer, old).state).toBe('couldnt_open');
    const untrusted = newPhoneCtx(
      [device('computer', computer.publicKey)],
      new Map([[old.id, { by: me.deviceId, wrapped }]]),
    );
    expect(openMessage(untrusted, old).state).toBe('couldnt_open');
    // A wrap the computer made itself is refused too.
    const byComputer = newPhoneCtx(
      [device('computer', computer.publicKey)],
      new Map([[old.id, { by: COMPUTER_ID, wrapped }]]),
    );
    expect(openMessage(byComputer, old).state).toBe('couldnt_open');
  });

  it('refuses a re-wrap moved to another message (AAD)', async () => {
    const { me, old, other, items } = await setup();
    const ctx = newPhoneCtx(
      [device('computer', computer.publicKey), trustedPhone(me)],
      new Map([[other.id, { by: me.deviceId, wrapped: items.get(old.id)! }]]),
    );
    expect(openMessage(ctx, other).state).toBe('couldnt_open');
  });

  it('refuses a re-wrap after the approving phone was removed', async () => {
    const { me, old, items } = await setup();
    // Removed: `syncTrusted` dropped it from this phone's list.
    const ctx = newPhoneCtx(
      [device('computer', computer.publicKey)],
      new Map([[old.id, { by: me.deviceId, wrapped: items.get(old.id)! }]]),
    );
    expect(openMessage(ctx, old).state).toBe('couldnt_open');
  });

  it('reads every page of a chat and refuses a bad answer', async () => {
    const id = msgId(1);
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: { items: [{ message_id: id, by: NEW_ID, wrapped: 'YQ' }], next: '4' },
      })
      .mockResolvedValueOnce({ status: 200, body: { items: [] } });
    const found = await readRewraps({ read }, AGENT_ID, NEW_ID);
    expect(found?.get(id)).toEqual({ by: NEW_ID, wrapped: 'YQ' });
    expect(read).toHaveBeenLastCalledWith(AGENT_ID, NEW_ID, '4');
    expect(
      await readRewraps(
        { read: async () => ({ status: 200, body: { items: 'x' } }) },
        AGENT_ID,
        NEW_ID,
      ),
    ).toBeUndefined();
  });
});

vi.mock('./pair-api', () => ({
  rewrapApi: () => ({ upload: async () => ({ status: 204, body: undefined }) }),
}));

describe('verification edges (PR #158)', () => {
  it('never wraps for a phone this phone no longer trusts', async () => {
    const { store, me } = await approvingPhone();
    await queueRewrap(store, { id: NEW_ID, public_key: base64urlEncode(newPhone.publicKey) });
    // The new phone was removed here since: no longer trusted.
    await saveTrusted(store, [device('computer', computer.publicKey)]);
    const upload = vi.fn(async () => ({ status: 204, body: undefined }));
    await runRewrapJobs(deps(store, [reply(1, [me.publicKey])], upload));
    expect(upload).not.toHaveBeenCalled();
    expect(await hasRewrapWork(store)).toBe(false);
  });

  it('never wraps for a trusted id under a key other than the approved one', async () => {
    const { store, me } = await approvingPhone();
    await queueRewrap(store, { id: NEW_ID, public_key: base64urlEncode(stranger.publicKey) });
    const upload = vi.fn(async () => ({ status: 204, body: undefined }));
    await runRewrapJobs(deps(store, [reply(1, [me.publicKey])], upload));
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps the job when a chat address could not be read (offline)', async () => {
    const { store } = await approvingPhone();
    await queueRewrap(store, { id: NEW_ID, public_key: base64urlEncode(newPhone.publicKey) });
    const { shareHistory } = await import('./share-history');
    const api = {
      getAgent: vi.fn(async () => {
        throw new Error('offline');
      }),
      listMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
    };
    await shareHistory(api, store, [AGENT_ID]);
    expect(await hasRewrapWork(store)).toBe(true);
  });

  async function shared() {
    const { store, me } = await approvingPhone();
    const old = reply(7, [me.publicKey]);
    const chunked = reply(8, [me.publicKey], ['a', 'b']);
    await queueRewrap(store, { id: NEW_ID, public_key: base64urlEncode(newPhone.publicKey) });
    const items = new Map<string, string>();
    await runRewrapJobs(
      deps(store, [old, chunked], async (_a, body) => {
        for (const i of body.items) items.set(i.message_id, i.wrapped);
        return { status: 204, body: undefined };
      }),
    );
    return { me, old, chunked, items };
  }

  it('refuses a re-wrap whose by is this phone itself', async () => {
    const { old, items } = await shared();
    const ctx = newPhoneCtx(
      [device('computer', computer.publicKey), device('phone', newPhone.publicKey)],
      new Map([[old.id, { by: NEW_ID, wrapped: items.get(old.id)! }]]),
    );
    expect(openMessage(ctx, old).state).toBe('couldnt_open');
  });

  it('refuses a re-wrap moved to another chat, account or chunked message', async () => {
    const { me, old, chunked, items } = await shared();
    const trusted = [device('computer', computer.publicKey), device('phone', me.publicKey)];
    for (const ids of [
      { accountId: ACCOUNT, agentId: 'other-agent' },
      { accountId: 'con_' + 'b'.repeat(20), agentId: AGENT },
    ]) {
      const ctx = createPhoneContext({
        ...ids,
        me: { deviceId: NEW_ID, publicKey: newPhone.publicKey, privateKey: newPhone.privateKey },
        trusted,
        nextSeq: () => 1,
        rewraps: new Map([[old.id, { by: me.deviceId, wrapped: items.get(old.id)! }]]),
      });
      expect(openMessage(ctx, old).state).toBe('couldnt_open');
    }
    const moved = newPhoneCtx(
      trusted,
      new Map([[old.id, { by: me.deviceId, wrapped: items.get(chunked.id)! }]]),
    );
    expect(openMessage(moved, old).state).toBe('couldnt_open');
    const ok = newPhoneCtx(
      trusted,
      new Map([[chunked.id, { by: me.deviceId, wrapped: items.get(chunked.id)! }]]),
    );
    expect(openMessage(ok, chunked)).toMatchObject({ state: 'ok', text: 'ab' });
  });

  async function newPhoneChats(
    trusted: TrustedDevice[],
    read: () => Promise<{ status: number; body: unknown }>,
  ) {
    const store = memoryStore();
    await store.setItemAsync(
      DEVICE_KEY_NAME,
      JSON.stringify({
        v: 1,
        public_key: base64urlEncode(newPhone.publicKey),
        private_key: base64urlEncode(newPhone.privateKey),
      }),
    );
    await saveTrusted(store, trusted);
    return new PrivateChats({
      store,
      replay: {
        load: () => Promise.resolve({}),
        save: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      addressOf: () => Promise.resolve(ADDRESS),
      rewraps: { read },
    });
  }

  it('lost keys notice: re-wrapped messages count as readable', async () => {
    const { me, old, items } = await shared();
    const read = vi.fn(async () => ({
      status: 200,
      body: { items: [{ message_id: old.id, by: me.deviceId, wrapped: items.get(old.id)! }] },
    }));
    const c = await newPhoneChats(
      [device('computer', computer.publicKey), device('phone', me.publicKey)],
      read,
    );
    await c.context(AGENT_ID);
    expect(c.open(AGENT_ID, [old])).toBeUndefined();
    await c.context(AGENT_ID);
    expect(c.open(AGENT_ID, [old])).toMatchObject([{ state: 'ok', text: 'reply 7' }]);
    // Without a computer: pair again, not "keys lost".
    const noComputer = await newPhoneChats([device('phone', me.publicKey)], read);
    await noComputer.context(AGENT_ID);
    noComputer.open(AGENT_ID, [old]);
    await noComputer.context(AGENT_ID);
    noComputer.open(AGENT_ID, [old]);
    expect(noComputer.notice(AGENT_ID)).toBe(PAIR_AGAIN);
  });

  it('lost keys notice still shows when no re-wrap can be had, and reads only once', async () => {
    const { me, old } = await shared();
    for (const answer of [
      { status: 200, body: { items: [] } },
      { status: 500, body: undefined },
    ]) {
      const read = vi.fn(async () => answer);
      const c = await newPhoneChats([device('phone', me.publicKey)], read);
      await c.context(AGENT_ID);
      c.open(AGENT_ID, [old]);
      await c.context(AGENT_ID);
      c.open(AGENT_ID, [old]);
      expect(c.notice(AGENT_ID)).toBe(LOST_KEYS);
      c.open(AGENT_ID, [old]);
      await c.context(AGENT_ID);
      expect(read).toHaveBeenCalledTimes(1);
    }
  });
});
