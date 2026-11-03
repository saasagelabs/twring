import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CredentialCipher, CredentialDecryptError, credentialAad } from './cipher';
import { JsonFileCollection, StoreCorruptError } from './collection';
import { agentRecordSchema, createFileStores, type AgentRecord } from './repositories';

// Verifier edge cases for the M7 store: the credential cipher and the JSON file collection.

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const keysA = { currentVersion: 1, keys: new Map([[1, KEY_A]]) };
const AGENT = 'agt_aaaaaaaaaaaaaaaaaaaa';
const OTHER_AGENT = 'agt_bbbbbbbbbbbbbbbbbbbb';
const SECRET = 'sk-edge-very-secret-value';

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
  const dir = await mkdtemp(join(tmpdir(), 'cord-store-edge-'));
  dirs.push(dir);
  return dir;
}

describe('CredentialCipher edge cases', () => {
  const aad = credentialAad('dev-user', AGENT);

  it('refuses a truncated authentication tag (GCM tag length must be pinned to 16 bytes)', () => {
    const cipher = new CredentialCipher(keysA);
    const sealed = cipher.seal(SECRET, aad);
    // A 4-byte prefix of the real tag. Without authTagLength, Node accepts it (DEP0182), which cuts
    // forgery resistance from 2^128 to 2^32 for anyone able to write the data file.
    const short = Buffer.from(sealed.tag, 'base64').subarray(0, 4).toString('base64');
    expect(() => cipher.open({ ...sealed, tag: short }, aad)).toThrow(CredentialDecryptError);
  });

  it('round-trips unicode and very long secrets', () => {
    const cipher = new CredentialCipher(keysA);
    for (const secret of ['pässwörd-🔑-秘密', 'x'.repeat(4096)]) {
      expect(cipher.open(cipher.seal(secret, aad), aad)).toBe(secret);
    }
  });

  it('an unknown key version fails closed with a generic message', () => {
    const cipher = new CredentialCipher(keysA);
    const sealed = cipher.seal(SECRET, aad);
    let error: unknown;
    try {
      cipher.open({ ...sealed, key_version: 7 }, aad);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CredentialDecryptError);
    expect(String(error)).not.toContain(SECRET);
    expect(String(error)).not.toContain(KEY_A);
  });

  it('garbage base64 in any field is a decrypt error, never a crash or partial plaintext', () => {
    const cipher = new CredentialCipher(keysA);
    const sealed = cipher.seal(SECRET, aad);
    for (const field of ['iv', 'ciphertext', 'tag'] as const) {
      expect(() => cipher.open({ ...sealed, [field]: '!!!not base64!!!' }, aad)).toThrow(
        CredentialDecryptError,
      );
    }
  });

  it('constructor errors name the version but never the key material', () => {
    const bad = Buffer.alloc(31, 3).toString('base64');
    let error: unknown;
    try {
      new CredentialCipher({ currentVersion: 4, keys: new Map([[4, bad]]) });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toMatch(/version 4/);
    expect(String(error)).not.toContain(bad);
    expect(() => new CredentialCipher({ currentVersion: 2, keys: new Map([[1, KEY_A]]) })).toThrow(
      /current credential key is missing/,
    );
  });
});

describe('EncryptedCredentialVault on disk', () => {
  it('a sealed secret copied onto another agent row in the file does not decrypt (AAD)', async () => {
    const dir = await tempDir();
    const stores = createFileStores(dir, keysA);
    await stores.credentials.put('dev-user', AGENT, SECRET);
    const file = join(dir, 'credentials.json');
    const rows = JSON.parse(await readFile(file, 'utf8')) as { agent_id: string }[];
    await writeFile(file, JSON.stringify([...rows, { ...rows[0]!, agent_id: OTHER_AGENT }]));
    const reopened = createFileStores(dir, keysA);
    expect(await reopened.credentials.get('dev-user', AGENT)).toBe(SECRET);
    await expect(reopened.credentials.get('dev-user', OTHER_AGENT)).rejects.toBeInstanceOf(
      CredentialDecryptError,
    );
  });

  it('a row sealed under a retired key version is unreadable but still present (has = true)', async () => {
    const dir = await tempDir();
    await createFileStores(dir, keysA).credentials.put('dev-user', AGENT, SECRET);
    const rotatedAway = createFileStores(dir, {
      currentVersion: 2,
      keys: new Map([[2, Buffer.alloc(32, 2).toString('base64')]]),
    });
    expect(await rotatedAway.credentials.has('dev-user', AGENT)).toBe(true);
    await expect(rotatedAway.credentials.get('dev-user', AGENT)).rejects.toBeInstanceOf(
      CredentialDecryptError,
    );
  });
});

describe('JsonFileCollection: one bad row (review finding 3)', () => {
  it('skips a bad row, keeps it aside in .rejected, and saves only the good rows', async () => {
    const dir = await tempDir();
    const file = join(dir, 'agents.json');
    const good = [
      agent({ id: 'agt_aaaaaaaaaaaaaaaaaaaa' }),
      agent({ id: 'agt_bbbbbbbbbbbbbbbbbbbb' }),
    ];
    await writeFile(file, JSON.stringify([good[0], { id: 'nope', odd: true }, good[1]]));
    const skipped: { file: string; count: number }[] = [];
    const collection = new JsonFileCollection(file, agentRecordSchema, {
      onRowsSkipped: (name, count) => skipped.push({ file: name, count }),
    });
    expect((await collection.read()).map((row) => row.id)).toEqual(good.map((row) => row.id));
    expect(skipped).toEqual([{ file, count: 1 }]);
    const rejected = (await readFile(`${file}.rejected`, 'utf8')).trim().split('\n');
    expect(rejected.map((line) => JSON.parse(line) as unknown)).toEqual([
      { id: 'nope', odd: true },
    ]);
    await collection.update((items) => ({ items, result: undefined }));
    const saved = JSON.parse(await readFile(file, 'utf8')) as AgentRecord[];
    expect(saved.map((row) => row.id)).toEqual(good.map((row) => row.id));
  });

  it('still fails closed when no row at all is readable (a schema mismatch, not one bad row)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'agents.json');
    await writeFile(file, JSON.stringify([{ id: 'nope' }, { id: 'also-nope' }]));
    await expect(new JsonFileCollection(file, agentRecordSchema).read()).rejects.toBeInstanceOf(
      StoreCorruptError,
    );
  });
});

describe('JsonFileCollection edge cases', () => {
  it('an update on a damaged file refuses and leaves the file exactly as it was', async () => {
    const dir = await tempDir();
    const file = join(dir, 'agents.json');
    await writeFile(file, '[{"broken": true');
    const collection = new JsonFileCollection(file, agentRecordSchema);
    await expect(
      collection.update((items) => ({ items: [...items, agent()], result: undefined })),
    ).rejects.toBeInstanceOf(StoreCorruptError);
    expect(await readFile(file, 'utf8')).toBe('[{"broken": true');
    expect(await readdir(dir)).toEqual(['agents.json']);
  });

  it('a zero-byte file (crash before data reached disk) fails closed as corrupt', async () => {
    const dir = await tempDir();
    const file = join(dir, 'agents.json');
    await writeFile(file, '');
    await expect(new JsonFileCollection(file, agentRecordSchema).read()).rejects.toBeInstanceOf(
      StoreCorruptError,
    );
  });

  it('the corrupt-file error names the file but never its contents', async () => {
    const dir = await tempDir();
    const file = join(dir, 'credentials.json');
    await writeFile(file, `{"secret":"${SECRET}"`);
    const error: unknown = await new JsonFileCollection(file, agentRecordSchema)
      .read()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StoreCorruptError);
    expect(String(error)).not.toContain(SECRET);
  });

  it('a change that throws releases the lock and saves nothing', async () => {
    const dir = await tempDir();
    const file = join(dir, 'agents.json');
    const collection = new JsonFileCollection(file, agentRecordSchema);
    await expect(
      collection.update(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await collection.update((items) => ({ items: [...items, agent()], result: undefined }));
    expect(await collection.read()).toHaveLength(1);
    expect(await readdir(dir)).toEqual(['agents.json']);
  });

  it('a failed save removes its temp file and keeps serving the last saved state', async () => {
    const dir = await tempDir();
    const file = join(dir, 'agents.json');
    const collection = new JsonFileCollection(file, agentRecordSchema);
    expect(await collection.read()).toEqual([]);
    // Make the rename target un-replaceable: a directory where the data file should be.
    await mkdir(file);
    await expect(
      collection.update((items) => ({ items: [...items, agent()], result: undefined })),
    ).rejects.toThrow();
    expect(await collection.read()).toEqual([]);
    expect(await readdir(dir)).toEqual(['agents.json']);
  });

  it('many interleaved writes to three collections under one data dir all land', async () => {
    const dir = await tempDir();
    const stores = createFileStores(dir, keysA);
    const ids = Array.from({ length: 15 }, (_, n) => `agt_${String(n).padStart(20, 'c')}`);
    await Promise.all(
      ids.flatMap((id) => [
        stores.agents.create(agent({ id })),
        stores.credentials.put('dev-user', id, `${SECRET}-${id}`),
      ]),
    );
    await Promise.all(ids.slice(0, 5).map((id) => stores.agents.delete('dev-user', id)));
    const reopened = createFileStores(dir, keysA);
    expect(await reopened.agents.list('dev-user')).toHaveLength(10);
    for (const id of ids) {
      expect(await reopened.credentials.get('dev-user', id)).toBe(`${SECRET}-${id}`);
    }
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('ids are never used as paths: a traversal-shaped user id stays a row value', async () => {
    const dir = await tempDir();
    const stores = createFileStores(dir, keysA);
    await stores.credentials.put('../../etc', AGENT, SECRET);
    expect((await readdir(dir)).sort()).toEqual(['credentials.json']);
    expect(await stores.credentials.get('dev-user', AGENT)).toBeUndefined();
  });
});
