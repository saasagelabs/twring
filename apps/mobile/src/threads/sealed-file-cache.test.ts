import { base64urlEncode, fileAad, newFileKey, sealFile } from '@twring/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Entry = { bytes: Uint8Array } | 'folder';
const fs = vi.hoisted(() => ({
  entries: new Map<string, unknown>(),
  remote: new Map<string, Uint8Array>(),
  downloads: 0,
}));
vi.mock('expo-file-system', () => {
  const join = (parent: unknown, name?: string) =>
    name === undefined
      ? String(parent)
      : `${String((parent as { path?: string }).path ?? parent)}/${name}`;
  class Directory {
    path: string;
    constructor(parent: unknown, name?: string) {
      this.path = join(parent, name);
    }
    get exists() {
      return fs.entries.has(this.path);
    }
    create() {
      fs.entries.set(this.path, 'folder');
    }
    delete() {
      for (const key of [...fs.entries.keys()])
        if (key === this.path || key.startsWith(`${this.path}/`)) fs.entries.delete(key);
    }
  }
  class File {
    path: string;
    constructor(parent: unknown, name?: string) {
      this.path = join(parent, name);
    }
    get uri() {
      return `file://${this.path}`;
    }
    get exists() {
      return fs.entries.has(this.path);
    }
    arrayBuffer() {
      const entry = fs.entries.get(this.path) as Entry;
      if (entry === 'folder' || entry === undefined) throw new Error('missing');
      return Promise.resolve(entry.bytes.buffer.slice(0) as ArrayBuffer);
    }
    write(bytes: Uint8Array) {
      fs.entries.set(this.path, { bytes });
    }
    delete() {
      fs.entries.delete(this.path);
    }
    static downloadFileAsync(uri: string, file: File) {
      fs.downloads += 1;
      const bytes = fs.remote.get(uri);
      if (bytes === undefined) return Promise.reject(new Error('404'));
      fs.entries.set(file.path, { bytes });
      return Promise.resolve(file);
    }
  }
  return { Directory, File, Paths: { cache: 'cache' } };
});

import { clearSealedFiles, openSealedFile } from './sealed-file-cache';

const ids = { accountId: 'con_aaaaaaaaaaaa', agentId: 'local' };
const agentId = 'agt_aaaaaaaaaaaaaaaaaaaa';
const plain = new Uint8Array([1, 2, 3, 4, 5]);
const source = (_agent: string, fileId: string) =>
  Promise.resolve({ uri: `https://example.test/${fileId}`, headers: {} });

function entry(fileId: string, bytes = plain, key = newFileKey()) {
  fs.remote.set(`https://example.test/${fileId}`, sealFile(key, bytes, fileAad(ids)));
  return {
    file_id: fileId,
    key: base64urlEncode(key),
    name: 'photo.jpg',
    mime: 'image/jpeg',
    size: bytes.length,
  };
}

beforeEach(() => {
  fs.entries.clear();
  fs.remote.clear();
  fs.downloads = 0;
});

describe('opening sealed files (ADR-045)', () => {
  it('opens a sealed photo once and reuses the cache', async () => {
    const file = entry('fil_aaaaaaaaaaaaaaaaaaaa');
    const first = await openSealedFile(agentId, file, ids, { source });
    expect(first).toEqual({ uri: expect.stringContaining('fil_aaaaaaaaaaaaaaaaaaaa') as string });
    const again = await openSealedFile(agentId, file, ids, { source });
    expect(again).toEqual(first);
    expect(fs.downloads).toBe(1);
    // The temp download is gone; the cached copy holds the plaintext.
    const left = [...fs.entries.keys()].filter((key) => key.includes('fil_a'));
    expect(left).toHaveLength(1);
    expect((fs.entries.get(left[0]) as { bytes: Uint8Array }).bytes).toEqual(plain);
  });

  it('swapped blob shows couldnt_open', async () => {
    const file = entry('fil_bbbbbbbbbbbbbbbbbbbb');
    // The server hands back a blob sealed with another key.
    fs.remote.set(
      'https://example.test/fil_bbbbbbbbbbbbbbbbbbbb',
      sealFile(newFileKey(), plain, fileAad(ids)),
    );
    expect(await openSealedFile(agentId, file, ids, { source })).toEqual({
      error: 'couldnt_open',
    });
    // A cut blob and a blob too short to hold a tag fail the same way.
    const cut = entry('fil_cccccccccccccccccccc');
    fs.remote.set(
      'https://example.test/fil_cccccccccccccccccccc',
      fs.remote.get('https://example.test/fil_cccccccccccccccccccc')!.slice(0, 20),
    );
    expect(await openSealedFile(agentId, cut, ids, { source })).toEqual({ error: 'couldnt_open' });
    // A right blob whose opened length is not the size the message says.
    const lying = { ...entry('fil_dddddddddddddddddddd'), size: 99 };
    expect(await openSealedFile(agentId, lying, ids, { source })).toEqual({
      error: 'couldnt_open',
    });
    // Nothing from a failed open stays in the cache or as a temp file.
    expect([...fs.entries.keys()].filter((key) => /fil_[bcd]/.test(key))).toEqual([]);
  });

  it('two bubbles of one file download it once', async () => {
    const file = entry('fil_eeeeeeeeeeeeeeeeeeee');
    const [a, b] = await Promise.all([
      openSealedFile(agentId, file, ids, { source }),
      openSealedFile(agentId, file, ids, { source }),
    ]);
    expect(a).toEqual(b);
    expect('uri' in a).toBe(true);
    expect(fs.downloads).toBe(1);
  });

  it('clearSealedFiles removes the folder', async () => {
    await openSealedFile(agentId, entry('fil_ffffffffffffffffffff'), ids, { source });
    expect(fs.entries.size).toBeGreaterThan(0);
    await clearSealedFiles();
    expect([...fs.entries.keys()].filter((key) => key.includes('sealed-files'))).toEqual([]);
  });
});
