import {
  base64urlDecode,
  base64urlEncode,
  ReplayWindow,
  type RecoveryBackupRequest,
} from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { loadDeviceKey, loadOrCreateDeviceKey, nextSeq } from './device-key';
import { confirmPairing, loadTrusted, type TrustedDevice } from './pairing';
import {
  newRecoveryWords,
  restoreFromWords,
  restoreOffer,
  saveRecoveryKey,
  wroteDown,
  type RecoveryApi,
} from './recovery';
import { memoryStore } from './test-fixtures';

const ACCOUNT = 'hosted_u1';
const computer: TrustedDevice = {
  id: `dev_${'c'.repeat(20)}`,
  kind: 'computer',
  name: 'Computer',
  public_key: base64urlEncode(new Uint8Array(32).fill(1)),
  verified_at: '2026-11-25T10:00:00.000Z',
};

/** A fake server that keeps what the phone sends, and records every request body. */
function fakeServer(options: { removed?: boolean } = {}) {
  let saved: RecoveryBackupRequest | undefined;
  const bodies: unknown[] = [];
  const put = vi.fn((body: RecoveryBackupRequest): Promise<{ status: number; body: unknown }> => {
    bodies.push(body);
    saved = body;
    return Promise.resolve({ status: 200, body: { updated_at: '2026-11-25T10:00:00.000Z' } });
  });
  const get = vi.fn(() =>
    Promise.resolve(
      saved === undefined
        ? { status: 404, body: { error: { code: 'no_backup' } } }
        : {
            status: 200,
            body: {
              ...saved,
              updated_at: '2026-11-25T10:00:00.000Z',
              device_removed: options.removed === true,
            },
          },
    ),
  );
  const api: RecoveryApi = {
    put,
    get,
    remove: () => Promise.resolve({ status: 204, body: undefined }),
  };
  return {
    api,
    get,
    put,
    bodies,
    tamper: (index: number) => {
      const bytes = base64urlDecode(saved!.sealed);
      bytes[index] = bytes[index] ^ 1;
      saved = { ...saved!, sealed: base64urlEncode(bytes) };
    },
  };
}

async function pairedPhone() {
  const store = memoryStore();
  const me = await loadOrCreateDeviceKey(store);
  await confirmPairing({ store }, computer);
  return { store, me };
}

async function found(api: RecoveryApi, store = memoryStore()) {
  const offer = await restoreOffer({ api, store });
  if (offer.kind !== 'found') throw new Error(`no backup: ${offer.kind}`);
  return offer.backup;
}

describe('recovery key on the phone', () => {
  it('asks back words 3 and 9, in any case', () => {
    const words = newRecoveryWords();
    expect(wroteDown(words, [` ${words[2].toUpperCase()} `, words[8]])).toBe(true);
    expect(wroteDown(words, [words[8], words[2]])).toBe(words[2] === words[8]);
  });

  it('server never receives the words', async () => {
    const { store } = await pairedPhone();
    const server = fakeServer();
    const log = vi.fn();
    const words = newRecoveryWords();
    expect(await saveRecoveryKey({ api: server.api, store, account: ACCOUNT, log }, words)).toEqual(
      {
        ok: true,
      },
    );
    expect(server.bodies).toHaveLength(1);
    const body = server.bodies[0] as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['check', 'device_id', 'salt', 'sealed']);
    const sent = JSON.stringify(server.bodies);
    expect(sent).not.toContain(words.join(' '));
    for (const value of Object.values(body)) expect(words).not.toContain(value);
    const logged = JSON.stringify(log.mock.calls);
    // Whole words, in the logged fields: fixed event names such as `e2e_recovery_saved` hold
    // word-list letters ("save") by chance, and were flaky as substrings.
    expect(logged).not.toContain(words.join(' '));
    const fields = JSON.stringify(log.mock.calls.map((call: unknown[]) => call.slice(1)));
    const tokens = new Set(fields.toLowerCase().split(/[^a-z0-9]+/));
    for (const word of words) expect(tokens.has(word)).toBe(false);
    // Nor are they kept on the phone.
    const kept = JSON.stringify([...store.m.values()]);
    expect(kept).not.toContain(words.join(' '));
  });

  it('restore on a new phone makes it the same device id, with no new pairing', async () => {
    const { store, me } = await pairedPhone();
    const server = fakeServer();
    const words = newRecoveryWords();
    await saveRecoveryKey({ api: server.api, store, account: ACCOUNT }, words);

    const newPhone = memoryStore();
    const backup = await found(server.api, newPhone);
    const typed = `  ${words.join('   ').toUpperCase()}\n`;
    const result = await restoreFromWords(
      { api: server.api, store: newPhone, account: ACCOUNT, now: () => 1_800_000_000_000 },
      backup,
      typed,
    );
    expect(result).toEqual({ ok: true, deviceId: me.deviceId });
    expect((await loadDeviceKey(newPhone))?.deviceId).toBe(me.deviceId);
    expect(await loadTrusted(newPhone)).toEqual([computer]);
    // The next message goes past anything the old phone sent, so it is never a replay.
    expect(await nextSeq(newPhone)).toBe(1_800_000_000_001);
    // A phone that has a key is never offered a restore.
    expect(await restoreOffer({ api: server.api, store: newPhone })).toEqual({ kind: 'none' });
  });

  it('a restore drops a computer that was removed while the phone was lost', async () => {
    const { store } = await pairedPhone();
    const server = fakeServer();
    const words = newRecoveryWords();
    await saveRecoveryKey({ api: server.api, store, account: ACCOUNT }, words);

    const newPhone = memoryStore();
    const backup = await found(server.api, newPhone);
    const list = vi.fn(() =>
      Promise.resolve({
        devices: [
          {
            id: computer.id,
            kind: 'computer',
            name: 'Computer',
            public_key: computer.public_key,
            added_at: '2026-11-25T10:00:00.000Z',
            revoked_at: '2026-11-25T11:00:00.000Z',
          },
        ],
      }),
    );
    const result = await restoreFromWords(
      { api: server.api, store: newPhone, account: ACCOUNT, devices: { list } },
      backup,
      words.join(' '),
    );
    expect(result.ok).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    expect(await loadTrusted(newPhone)).toEqual([]);
  });

  it('a restore still works when the device list cannot be read', async () => {
    const { store, me } = await pairedPhone();
    const server = fakeServer();
    const words = newRecoveryWords();
    await saveRecoveryKey({ api: server.api, store, account: ACCOUNT }, words);

    const newPhone = memoryStore();
    const backup = await found(server.api, newPhone);
    const log = vi.fn();
    const result = await restoreFromWords(
      {
        api: server.api,
        store: newPhone,
        account: ACCOUNT,
        log,
        devices: { list: () => Promise.reject(new Error('offline')) },
      },
      backup,
      words.join(' '),
    );
    expect(result).toEqual({ ok: true, deviceId: me.deviceId });
    // The chat list checks again when a chat opens.
    expect(await loadTrusted(newPhone)).toEqual([computer]);
    expect(log).toHaveBeenCalledWith('e2e_recovery_sync_failed');
  });

  it('refuses one wrong word before any server call or change', async () => {
    const { store } = await pairedPhone();
    const server = fakeServer();
    const words = newRecoveryWords();
    await saveRecoveryKey({ api: server.api, store, account: ACCOUNT }, words);
    const newPhone = memoryStore();
    const backup = await found(server.api, newPhone);
    const calls = server.get.mock.calls.length;
    const wrong = [...words.slice(0, 11), words[11] === 'abandon' ? 'ability' : 'abandon'];
    const result = await restoreFromWords(
      { api: server.api, store: newPhone, account: ACCOUNT },
      backup,
      wrong.join(' '),
    );
    expect(result).toEqual({ ok: false, code: 'wrong_words' });
    expect(server.get.mock.calls.length).toBe(calls);
    expect(newPhone.m.size).toBe(0);
  });

  it('says a damaged backup cannot be opened, and changes nothing', async () => {
    const { store } = await pairedPhone();
    const server = fakeServer();
    const words = newRecoveryWords();
    await saveRecoveryKey({ api: server.api, store, account: ACCOUNT }, words);
    server.tamper(40);
    const newPhone = memoryStore();
    const result = await restoreFromWords(
      { api: server.api, store: newPhone, account: ACCOUNT },
      await found(server.api, newPhone),
      words.join(' '),
    );
    expect(result).toEqual({ ok: false, code: 'damaged' });
    expect(newPhone.m.size).toBe(0);
  });

  it('does not open a backup for another account', async () => {
    const { store } = await pairedPhone();
    const server = fakeServer();
    const words = newRecoveryWords();
    await saveRecoveryKey({ api: server.api, store, account: ACCOUNT }, words);
    const newPhone = memoryStore();
    const result = await restoreFromWords(
      { api: server.api, store: newPhone, account: 'hosted_u2' },
      await found(server.api, newPhone),
      words.join(' '),
    );
    expect(result).toEqual({ ok: false, code: 'damaged' });
  });

  it('reports a backup of a removed phone instead of offering it', async () => {
    const { store } = await pairedPhone();
    const server = fakeServer({ removed: true });
    await saveRecoveryKey({ api: server.api, store, account: ACCOUNT }, newRecoveryWords());
    expect(await restoreOffer({ api: server.api, store: memoryStore() })).toEqual({
      kind: 'removed',
    });
  });

  it('offers nothing when the server has no backup or cannot be reached', async () => {
    expect(await restoreOffer({ api: fakeServer().api, store: memoryStore() })).toEqual({
      kind: 'none',
    });
    const offline: RecoveryApi = {
      get: () => Promise.reject(new Error('offline')),
      put: () => Promise.reject(new Error('offline')),
      remove: () => Promise.reject(new Error('offline')),
    };
    expect(await restoreOffer({ api: offline, store: memoryStore() })).toEqual({
      kind: 'network',
    });
  });

  it('cannot save without a device key, and says when the server refuses', async () => {
    const server = fakeServer();
    expect(
      await saveRecoveryKey(
        { api: server.api, store: memoryStore(), account: ACCOUNT },
        newRecoveryWords(),
      ),
    ).toEqual({ ok: false, code: 'no_device' });
    const { store } = await pairedPhone();
    server.put.mockResolvedValueOnce({ status: 404, body: undefined });
    expect(
      await saveRecoveryKey({ api: server.api, store, account: ACCOUNT }, newRecoveryWords()),
    ).toEqual({ ok: false, code: 'refused' });
  });
});

describe('two phones with one key (restore while the old phone still works)', () => {
  it('the computer keeps taking messages from both phones', async () => {
    const { store: oldPhone, me } = await pairedPhone();
    const server = fakeServer();
    const words = newRecoveryWords();
    await saveRecoveryKey({ api: server.api, store: oldPhone, account: ACCOUNT }, words);
    let clock = 1_800_000_000_000;
    const now = () => clock;
    const computerSeen = new ReplayWindow();
    // The old phone sent a few messages before the restore.
    for (let i = 0; i < 3; i++)
      expect(computerSeen.accept(me.deviceId, await nextSeq(oldPhone, now))).toBe(true);
    const newPhone = memoryStore();
    const backup = await found(server.api, newPhone);
    await restoreFromWords(
      { api: server.api, store: newPhone, account: ACCOUNT, now },
      backup,
      words.join(' '),
    );
    // Then both phones send, alternating, a few seconds apart.
    for (let i = 0; i < 5; i++) {
      clock += 2_000;
      expect(computerSeen.accept(me.deviceId, await nextSeq(newPhone, now))).toBe(true);
      clock += 2_000;
      expect(computerSeen.accept(me.deviceId, await nextSeq(oldPhone, now))).toBe(true);
    }
  });

  it('a phone that restarts still counts up from its saved seq', async () => {
    const s = memoryStore();
    s.m.set('twring.e2e.seq.v1', '5000');
    expect(await nextSeq(s, () => 10)).toBe(5001);
    expect(await nextSeq(s, () => 10)).toBe(5002);
    expect(await nextSeq(s, () => 9000)).toBe(9000);
  });
});
