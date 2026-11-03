import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallHistoryItem } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { CredentialCipher, CredentialDecryptError, credentialAad } from './cipher';
import { JsonFileCollection, MemoryCollection, StoreCorruptError } from './collection';
import {
  EncryptedCredentialVault,
  MAX_HISTORY_PER_USER,
  agentRecordSchema,
  createFileStores,
  createMemoryStores,
  type AgentRecord,
} from './repositories';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const keysA = { currentVersion: 1, keys: new Map([[1, KEY_A]]) };
const AGENT = 'agt_aaaaaaaaaaaaaaaaaaaa';
const OTHER_AGENT = 'agt_bbbbbbbbbbbbbbbbbbbb';
const SECRET = 'sk-test-very-secret-value';

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: AGENT,
    user_id: 'dev-user',
    name: 'Operator',
    protocol: 'cord-rest',
    endpoint_url: 'https://agent.example.com/cord/turns',
    voice_id: 'flux-haley-en',
    status: 'untested',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cord-store-'));
  dirs.push(dir);
  return dir;
}

it('persists a pending fresh session across store reloads and consumes it once', async () => {
  const dir = await tempDir();
  const first = createFileStores(dir, keysA);
  await first.agents.create(
    agent({
      protocol: 'cord-connector',
      endpoint_url: 'cord-connector://con_aaaaaaaaaaaaaaaaaaaa/echo',
    }),
  );
  expect(await first.agents.requestFreshSession('dev-user', AGENT)).toBe(true);
  const reloaded = createFileStores(dir, keysA);
  expect((await reloaded.agents.get('dev-user', AGENT))?.fresh_session_pending).toBe(true);
  expect(await reloaded.agents.consumeFreshSession('dev-user', AGENT)).toBe(true);
  expect(await reloaded.agents.consumeFreshSession('dev-user', AGENT)).toBe(false);
});

describe('CredentialCipher', () => {
  const aad = credentialAad('dev-user', AGENT);

  it('round-trips with a fresh IV each time and never stores plaintext', () => {
    const cipher = new CredentialCipher(keysA);
    const one = cipher.seal(SECRET, aad);
    const two = cipher.seal(SECRET, aad);
    expect(one.iv).not.toBe(two.iv);
    expect(Buffer.from(one.iv, 'base64')).toHaveLength(12);
    expect(one.key_version).toBe(1);
    expect(JSON.stringify(one)).not.toContain(SECRET);
    expect(cipher.open(one, aad)).toBe(SECRET);
  });

  it('detects tampering with the ciphertext, tag, or IV', () => {
    const cipher = new CredentialCipher(keysA);
    const sealed = cipher.seal(SECRET, aad);
    const flip = (b64: string) => {
      const bytes = Buffer.from(b64, 'base64');
      bytes[0] = bytes[0]! ^ 1;
      return bytes.toString('base64');
    };
    for (const field of ['ciphertext', 'tag', 'iv'] as const) {
      expect(() => cipher.open({ ...sealed, [field]: flip(sealed[field]) }, aad)).toThrow(
        CredentialDecryptError,
      );
    }
  });

  it('refuses a wrong key and a mismatched owner (AAD)', () => {
    const sealed = new CredentialCipher(keysA).seal(SECRET, aad);
    const wrongKey = new CredentialCipher({ currentVersion: 1, keys: new Map([[1, KEY_B]]) });
    expect(() => wrongKey.open(sealed, aad)).toThrow(CredentialDecryptError);
    const cipher = new CredentialCipher(keysA);
    expect(() => cipher.open(sealed, credentialAad('dev-user', OTHER_AGENT))).toThrow(
      CredentialDecryptError,
    );
    expect(() => cipher.open(sealed, credentialAad('someone-else', AGENT))).toThrow(
      CredentialDecryptError,
    );
  });

  it('reads secrets sealed with an older key version after rotation', () => {
    const old = new CredentialCipher(keysA).seal(SECRET, aad);
    const rotated = new CredentialCipher({
      currentVersion: 2,
      keys: new Map([
        [1, KEY_A],
        [2, KEY_B],
      ]),
    });
    expect(rotated.open(old, aad)).toBe(SECRET);
    expect(rotated.seal(SECRET, aad).key_version).toBe(2);
    // Once the old key is retired, its secrets are unreadable rather than misread.
    const retired = new CredentialCipher({ currentVersion: 2, keys: new Map([[2, KEY_B]]) });
    expect(() => retired.open(old, aad)).toThrow(CredentialDecryptError);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new CredentialCipher({ currentVersion: 1, keys: new Map([[1, 'AAAA']]) })).toThrow(
      /32 bytes/,
    );
  });
});

describe('EncryptedCredentialVault', () => {
  it('stores ciphertext only, replaces on put, and deletes', async () => {
    const rows = new MemoryCollection<never>();
    const vault = new EncryptedCredentialVault(rows, new CredentialCipher(keysA));
    await vault.put('dev-user', AGENT, SECRET);
    await vault.put('dev-user', AGENT, 'second-secret');
    expect(JSON.stringify(await rows.read())).not.toContain('secret-value');
    expect(await rows.read()).toHaveLength(1);
    expect(await vault.get('dev-user', AGENT)).toBe('second-secret');
    expect(await vault.get('other-user', AGENT)).toBeUndefined();
    await vault.delete('dev-user', AGENT);
    expect(await vault.has('dev-user', AGENT)).toBe(false);
  });
});

describe('agent repository', () => {
  it('scopes every query to the user', async () => {
    const { agents } = createMemoryStores(keysA);
    await agents.create(agent());
    expect(await agents.get('intruder', AGENT)).toBeUndefined();
    expect(await agents.list('intruder')).toEqual([]);
    expect(await agents.update('intruder', AGENT, { name: 'x' }, new Date())).toBeUndefined();
    expect(await agents.delete('intruder', AGENT)).toBe(false);
    expect(await agents.get('dev-user', AGENT)).toMatchObject({ name: 'Operator' });
  });

  it('lists newest first and clears the last test when reset to untested', async () => {
    const { agents } = createMemoryStores(keysA);
    await agents.create(agent());
    await agents.create(agent({ id: OTHER_AGENT, created_at: '2026-09-02T00:00:00.000Z' }));
    expect((await agents.list('dev-user')).map((a) => a.id)).toEqual([OTHER_AGENT, AGENT]);
    const test = { ok: true, checks: [], message: 'ok', tested_at: '2026-09-03T00:00:00.000Z' };
    await agents.update('dev-user', AGENT, { status: 'ready', last_test: test }, new Date());
    const reset = await agents.update('dev-user', AGENT, { status: 'untested' }, new Date());
    expect(reset?.last_test).toBeUndefined();
  });
});

describe('call history repository', () => {
  const item = (n: number): CallHistoryItem => ({
    call_id: `call_${String(n).padStart(20, '0')}`,
    agent_id: AGENT,
    agent_name: 'Operator',
    started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    duration_s: 5,
    outcome: 'completed',
    end_reason: 'hangup',
  });

  it('returns the newest first, bounded, per user', async () => {
    const { history } = createMemoryStores(keysA);
    for (let n = 0; n < MAX_HISTORY_PER_USER + 5; n += 1) await history.record('dev-user', item(n));
    await history.record('other-user', item(999));
    const all = await history.list('dev-user', 1000);
    expect(all).toHaveLength(MAX_HISTORY_PER_USER);
    expect(all[0]).toEqual(item(MAX_HISTORY_PER_USER + 4));
    expect(await history.list('dev-user', 50)).toHaveLength(50);
    expect(await history.list('other-user', 50)).toEqual([item(999)]);
  });
});

describe('deleting all of one user (DELETE /v1/me/data)', () => {
  it("removes only that user's rows from every store and reports counts", async () => {
    const stores = createMemoryStores(keysA);
    await stores.agents.create(agent());
    await stores.agents.create(agent({ id: OTHER_AGENT }));
    await stores.agents.create(agent({ user_id: 'other-user' }));
    await stores.credentials.put('dev-user', AGENT, SECRET);
    await stores.credentials.put('other-user', AGENT, 'other-secret');
    const call = {
      call_id: 'call_00000000000000000001',
      agent_id: AGENT,
      agent_name: 'Operator',
      started_at: '2026-01-01T00:00:00.000Z',
      duration_s: 5,
      outcome: 'completed' as const,
      end_reason: 'hangup' as const,
    };
    await stores.history.record('dev-user', call);
    await stores.history.record('other-user', call);

    expect(await stores.credentials.deleteAllForUser('dev-user')).toBe(1);
    expect(await stores.agents.deleteAllForUser('dev-user')).toBe(2);
    expect(await stores.history.deleteAllForUser('dev-user')).toBe(1);

    expect(await stores.agents.list('dev-user')).toEqual([]);
    expect(await stores.credentials.has('dev-user', AGENT)).toBe(false);
    expect(await stores.history.list('dev-user', 10)).toEqual([]);
    expect(await stores.agents.list('other-user')).toHaveLength(1);
    expect(await stores.credentials.get('other-user', AGENT)).toBe('other-secret');
    expect(await stores.history.list('other-user', 10)).toEqual([call]);
    expect(await stores.agents.deleteAllForUser('dev-user')).toBe(0);
  });
});

describe('file store', () => {
  it('persists across instances with atomic writes and no temp files left', async () => {
    const dir = await tempDir();
    const first = createFileStores(dir, keysA);
    await first.agents.create(agent());
    await first.credentials.put('dev-user', AGENT, SECRET);

    const second = createFileStores(dir, keysA);
    expect(await second.agents.get('dev-user', AGENT)).toMatchObject({ name: 'Operator' });
    expect(await second.credentials.get('dev-user', AGENT)).toBe(SECRET);
    expect((await readdir(dir)).sort()).toEqual(['agents.json', 'credentials.json']);
    expect(await readFile(join(dir, 'credentials.json'), 'utf8')).not.toContain(SECRET);
  });

  it('serializes concurrent writers so no update is lost', async () => {
    const dir = await tempDir();
    const { agents } = createFileStores(dir, keysA);
    const ids = Array.from({ length: 20 }, (_, n) => `agt_${String(n).padStart(20, 'a')}`);
    await Promise.all(ids.map((id) => agents.create(agent({ id }))));
    const reloaded = createFileStores(dir, keysA);
    expect(await reloaded.agents.list('dev-user')).toHaveLength(20);
  });

  it('refuses a damaged data file instead of treating it as empty', async () => {
    const dir = await tempDir();
    const file = join(dir, 'agents.json');
    await writeFile(file, '{ not json');
    const collection = new JsonFileCollection(file, agentRecordSchema);
    await expect(collection.read()).rejects.toBeInstanceOf(StoreCorruptError);
    await writeFile(file, JSON.stringify([{ id: 'nope' }]));
    await expect(new JsonFileCollection(file, agentRecordSchema).read()).rejects.toBeInstanceOf(
      StoreCorruptError,
    );
  });
});
