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
    get size() {
      const entry = fs.entries.get(this.path) as Entry | undefined;
      return entry === undefined || entry === 'folder' ? 0 : entry.bytes.length;
    }
    // As in expo-file-system 57 on Android and iOS: a moved File points at its new place.
    move(to: File) {
      fs.entries.set(to.path, fs.entries.get(this.path));
      fs.entries.delete(this.path);
      this.path = to.path;
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

  it('the uri it returns names a file that is still on disk', async () => {
    const opened = await openSealedFile(agentId, entry('fil_kkkkkkkkkkkkkkkkkkkk'), ids, {
      source,
    });
    if (!('uri' in opened)) throw new Error('did not open');
    expect(fs.entries.has(opened.uri.replace('file://', ''))).toBe(true);
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

  it('a clear during a download leaves nothing on disk', async () => {
    const file = entry('fil_gggggggggggggggggggg');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = { source: async (a: string, id: string) => (await gate, source(a, id)) };
    const pending = openSealedFile(agentId, file, ids, slow);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await clearSealedFiles();
    release();
    expect(await pending).toEqual({ error: 'couldnt_open' });
    expect([...fs.entries.keys()]).toEqual([]);
  });

  it('a blob sealed for another chat shows couldnt_open', async () => {
    const key = newFileKey();
    const file = {
      ...entry('fil_hhhhhhhhhhhhhhhhhhhh'),
      key: base64urlEncode(key),
    };
    fs.remote.set(
      'https://example.test/fil_hhhhhhhhhhhhhhhhhhhh',
      sealFile(key, plain, fileAad({ accountId: ids.accountId, agentId: 'other' })),
    );
    expect(await openSealedFile(agentId, file, ids, { source })).toEqual({ error: 'couldnt_open' });
  });

  it('refuses a file id that is not a server id, with no download', async () => {
    const file = { ...entry('fil_iiiiiiiiiiiiiiiiiiii'), file_id: '../x' };
    expect(await openSealedFile(agentId, file, ids, { source })).toEqual({ error: 'couldnt_open' });
    expect(fs.downloads).toBe(0);
  });

  it('a cached copy of the wrong size is opened again', async () => {
    const file = entry('fil_jjjjjjjjjjjjjjjjjjjj');
    await openSealedFile(agentId, file, ids, { source });
    const key = [...fs.entries.keys()].find((k) => k.endsWith('fil_jjjjjjjjjjjjjjjjjjjj'))!;
    fs.entries.set(key, { bytes: new Uint8Array([9]) });
    await openSealedFile(agentId, file, ids, { source });
    expect((fs.entries.get(key) as { bytes: Uint8Array }).bytes).toEqual(plain);
    expect(fs.downloads).toBe(2);
  });
});
