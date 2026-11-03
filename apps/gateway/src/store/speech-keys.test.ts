import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CredentialCipher, CredentialDecryptError } from './cipher';
import { JsonFileCollection, MemoryCollection, type Collection } from './collection';
import {
  EncryptedSpeechKeyVault,
  speechKeyAad,
  speechKeyRecordSchema,
  speechSettingsRecordSchema,
  type SpeechKeyRecord,
  type SpeechSettingsRecord,
} from './speech-keys';

const KEYS = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 9).toString('base64')]]) };
const KEY = 'dg-secret-key-abcd1234';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fileRows(): Promise<{ rows: Collection<SpeechKeyRecord>; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'speech-keys-'));
  dirs.push(dir);
  const file = join(dir, 'speech-keys.json');
  return { rows: new JsonFileCollection(file, speechKeyRecordSchema), file };
}

const variants: [string, () => Promise<{ rows: Collection<SpeechKeyRecord>; file?: string }>][] = [
  ['memory', () => Promise.resolve({ rows: new MemoryCollection<SpeechKeyRecord>() })],
  ['file', fileRows],
];

describe.each(variants)('EncryptedSpeechKeyVault (%s)', (_name, make) => {
  async function setup(now: () => Date = () => new Date('2026-10-27T10:00:00.000Z')) {
    const made = await make();
    return {
      ...made,
      vault: new EncryptedSpeechKeyVault(made.rows, new CredentialCipher(KEYS), now),
    };
  }

  it('put then get returns the key', async () => {
    const { vault } = await setup();
    await vault.put('alice', 'deepgram', KEY, new Date('2026-10-27T09:00:00.000Z'));
    expect(await vault.get('alice', 'deepgram')).toBe(KEY);
    expect(await vault.get('alice', 'cartesia')).toBeUndefined();
  });

  it('list shows last4 and never the key', async () => {
    const { vault } = await setup();
    await vault.put('alice', 'deepgram', KEY, new Date('2026-10-27T09:00:00.000Z'));
    const list = await vault.list('alice');
    expect(list).toHaveLength(1);
    expect(list[0]?.last4).toBe(KEY.slice(-4));
    expect(list[0]?.provider).toBe('deepgram');
    expect(list[0]?.verified_at).toBe('2026-10-27T09:00:00.000Z');
    expect(JSON.stringify(list)).not.toContain(KEY);
  });

  it('replace keeps created_at and updates updated_at and verified_at', async () => {
    let t = new Date('2026-10-27T10:00:00.000Z');
    const { vault, rows } = await setup(() => t);
    await vault.put('alice', 'deepgram', KEY, new Date('2026-10-27T10:00:00.000Z'));
    t = new Date('2026-10-28T10:00:00.000Z');
    await vault.put('alice', 'deepgram', 'new-key-wxyz9876', new Date('2026-10-28T09:00:00.000Z'));
    const stored = await rows.read();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.created_at).toBe('2026-10-27T10:00:00.000Z');
    expect(stored[0]?.updated_at).toBe('2026-10-28T10:00:00.000Z');
    expect(stored[0]?.verified_at).toBe('2026-10-28T09:00:00.000Z');
    expect(await vault.get('alice', 'deepgram')).toBe('new-key-wxyz9876');
    expect((await vault.list('alice'))[0]?.last4).toBe('9876');
  });

  it('refuses a short key and stores nothing', async () => {
    const { vault, rows } = await setup();
    const short = 'sh0rt';
    let message = '';
    await vault.put('alice', 'deepgram', short, new Date()).catch((e: Error) => {
      message = e.message;
    });
    expect(message).not.toBe('');
    expect(message).not.toContain(short);
    expect(await rows.read()).toEqual([]);
    expect(JSON.stringify(await vault.list('alice'))).not.toContain(short);
  });

  it('keeps users apart', async () => {
    const { vault } = await setup();
    await vault.put('alice', 'deepgram', KEY, new Date());
    expect(await vault.get('bob', 'deepgram')).toBeUndefined();
    expect(await vault.list('bob')).toEqual([]);
  });

  it('a row copied to another user fails to open', async () => {
    const { vault, rows } = await setup();
    await vault.put('alice', 'deepgram', KEY, new Date());
    await rows.update((items) => ({
      items: items.map((r) => ({ ...r, user_id: 'bob' })),
      result: undefined,
    }));
    await expect(vault.get('bob', 'deepgram')).rejects.toBeInstanceOf(CredentialDecryptError);
  });

  it('a row copied to another provider fails to open', async () => {
    const { vault, rows } = await setup();
    await vault.put('alice', 'deepgram', KEY, new Date());
    await rows.update((items) => ({
      items: items.map((r) => ({ ...r, provider: 'cartesia' as const })),
      result: undefined,
    }));
    await expect(vault.get('alice', 'cartesia')).rejects.toBeInstanceOf(CredentialDecryptError);
  });

  it('deleteAllForUser counts and leaves others; delete of an absent key resolves', async () => {
    const { vault } = await setup();
    await vault.put('alice', 'deepgram', KEY, new Date());
    await vault.put('alice', 'cartesia', 'cartesia-key-0001', new Date());
    await vault.put('bob', 'deepgram', 'bob-key-00002', new Date());
    await expect(vault.delete('carol', 'deepgram')).resolves.toBeUndefined();
    expect(await vault.deleteAllForUser('alice')).toBe(2);
    expect(await vault.list('alice')).toEqual([]);
    expect(await vault.get('bob', 'deepgram')).toBe('bob-key-00002');
    await vault.delete('bob', 'deepgram');
    expect(await vault.get('bob', 'deepgram')).toBeUndefined();
  });
});

describe('speech key storage', () => {
  it('does not write the key in plaintext to disk', async () => {
    const { rows, file } = await fileRows();
    const vault = new EncryptedSpeechKeyVault(rows, new CredentialCipher(KEYS));
    await vault.put('alice', 'deepgram', KEY, new Date());
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(KEY);
    expect(text).toContain('alice');
  });

  it('binds the AAD to user and provider', () => {
    expect(speechKeyAad('u1', 'deepgram')).toBe('cord-speech-key:v1:u1:deepgram');
  });
});

describe('EncryptedSpeechKeyVault listening setting', () => {
  function make() {
    const settings = new MemoryCollection<SpeechSettingsRecord>();
    const vault = new EncryptedSpeechKeyVault(
      new MemoryCollection<SpeechKeyRecord>(),
      new CredentialCipher(KEYS),
      () => new Date('2026-10-27T10:00:00.000Z'),
      settings,
    );
    return { vault, settings };
  }
  const at = new Date('2026-10-27T09:00:00.000Z');

  it('defaults to deepgram and keeps a choice per person', async () => {
    const { vault } = make();
    expect(await vault.getListening('alice')).toBe('deepgram');
    await vault.put('alice', 'deepgram', KEY, at);
    await vault.put('alice', 'xai', KEY, at);
    await vault.setListening('alice', 'xai');
    expect(await vault.getListening('alice')).toBe('xai');
    expect(await vault.getListening('bob')).toBe('deepgram');
  });

  it('removing the chosen provider key returns listening to the other, or the default', async () => {
    const { vault } = make();
    await vault.put('alice', 'deepgram', KEY, at);
    await vault.put('alice', 'xai', KEY, at);
    await vault.setListening('alice', 'xai');
    await vault.delete('alice', 'xai');
    expect(await vault.getListening('alice')).toBe('deepgram');
    await vault.setListening('alice', 'deepgram');
    await vault.put('alice', 'xai', KEY, at);
    await vault.delete('alice', 'deepgram');
    expect(await vault.getListening('alice')).toBe('xai');
    await vault.delete('alice', 'xai');
    expect(await vault.getListening('alice')).toBe('deepgram');
  });

  it('removing a key that is not the choice leaves the choice alone', async () => {
    const { vault } = make();
    await vault.put('alice', 'xai', KEY, at);
    await vault.put('alice', 'cartesia', KEY, at);
    await vault.setListening('alice', 'xai');
    await vault.delete('alice', 'cartesia');
    expect(await vault.getListening('alice')).toBe('xai');
  });

  it('deleteAllForUser clears the setting and counts only keys', async () => {
    const { vault, settings } = make();
    await vault.put('alice', 'xai', KEY, at);
    await vault.setListening('alice', 'xai');
    await vault.put('bob', 'xai', KEY, at);
    await vault.setListening('bob', 'xai');
    expect(await vault.deleteAllForUser('alice')).toBe(1);
    expect(await vault.getListening('alice')).toBe('deepgram');
    expect(await vault.getListening('bob')).toBe('xai');
    expect(await settings.read()).toHaveLength(1);
  });

  it('settings rows accept only a listening provider', () => {
    expect(speechSettingsRecordSchema.safeParse({ user_id: 'a', listening: 'xai' }).success).toBe(
      true,
    );
    expect(
      speechSettingsRecordSchema.safeParse({ user_id: 'a', listening: 'cartesia' }).success,
    ).toBe(false);
  });
});

describe('listening setting invariant', () => {
  const at = new Date('2026-10-27T09:00:00.000Z');
  function make() {
    const settings = new MemoryCollection<SpeechSettingsRecord>();
    const vault = new EncryptedSpeechKeyVault(
      new MemoryCollection<SpeechKeyRecord>(),
      new CredentialCipher(KEYS),
      () => new Date('2026-10-27T10:00:00.000Z'),
      settings,
    );
    return { vault, settings };
  }

  it('a stale xai row with no xai key reads as deepgram', async () => {
    const { vault, settings } = make();
    await settings.update(() => ({ items: [{ user_id: 'alice', listening: 'xai' }], result: 0 }));
    expect(await vault.getListening('alice')).toBe('deepgram');
    await vault.put('alice', 'deepgram', KEY, at);
    expect(await vault.getListening('alice')).toBe('deepgram');
  });

  it('a chosen provider without a key falls back to the one the person owns', async () => {
    const { vault, settings } = make();
    await settings.update(() => ({
      items: [{ user_id: 'alice', listening: 'deepgram' }],
      result: 0,
    }));
    await vault.put('alice', 'xai', KEY, at);
    expect(await vault.getListening('alice')).toBe('xai');
  });

  it('a corrupt settings file reads as the owned provider or default and is reported once per read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'speech-settings-'));
    dirs.push(dir);
    const file = join(dir, 'speech-settings.json');
    await writeFile(file, '{not json');
    const reports: number[] = [];
    EncryptedSpeechKeyVault.onSettingsUnreadable = () => reports.push(1);
    try {
      const vault = new EncryptedSpeechKeyVault(
        new MemoryCollection<SpeechKeyRecord>(),
        new CredentialCipher(KEYS),
        () => new Date(),
        new JsonFileCollection(file, speechSettingsRecordSchema),
      );
      await vault.put('alice', 'xai', KEY, at);
      expect(await vault.getListening('alice')).toBe('xai');
      await expect(vault.delete('alice', 'xai')).resolves.toBeUndefined();
      expect(reports.length).toBeGreaterThan(0);
    } finally {
      EncryptedSpeechKeyVault.onSettingsUnreadable = undefined;
    }
  });
});

describe('Delete my data with a corrupt settings file', () => {
  it('still removes the keys, reports the count and flags the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'speech-settings-'));
    dirs.push(dir);
    const file = join(dir, 'speech-settings.json');
    await writeFile(file, '{not json');
    let reports = 0;
    EncryptedSpeechKeyVault.onSettingsUnreadable = () => (reports += 1);
    try {
      const vault = new EncryptedSpeechKeyVault(
        new MemoryCollection<SpeechKeyRecord>(),
        new CredentialCipher(KEYS),
        () => new Date(),
        new JsonFileCollection(file, speechSettingsRecordSchema),
      );
      await vault.put('alice', 'xai', KEY, new Date());
      await expect(vault.deleteAllForUser('alice')).resolves.toBe(1);
      expect(await vault.list('alice')).toEqual([]);
      expect(reports).toBeGreaterThan(0);
      await expect(vault.deleteAllForUser('alice')).resolves.toBe(0);
    } finally {
      EncryptedSpeechKeyVault.onSettingsUnreadable = undefined;
    }
  });
});
