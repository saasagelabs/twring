import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake disk: file name to contents. `failMove` simulates the app being killed between writing
// the temporary file and moving it over the saved one.
const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failMove: false,
}));

vi.mock('expo-file-system', () => {
  class Directory {
    get exists() {
      return true;
    }
    create() {}
  }
  class File {
    name: string;
    constructor(_directory: Directory, name: string) {
      this.name = name;
    }
    get exists() {
      return disk.files.has(this.name);
    }
    text() {
      const contents = disk.files.get(this.name);
      return contents === undefined
        ? Promise.reject(new Error('missing'))
        : Promise.resolve(contents);
    }
    write(contents: string) {
      disk.files.set(this.name, contents);
    }
    delete() {
      if (!disk.files.delete(this.name)) throw new Error('missing');
    }
    move(destination: File, options?: { overwrite?: boolean }) {
      if (disk.failMove) return Promise.reject(new Error('killed'));
      const contents = disk.files.get(this.name);
      if (contents === undefined) return Promise.reject(new Error('missing'));
      if (disk.files.has(destination.name) && !options?.overwrite)
        return Promise.reject(new Error('exists'));
      disk.files.set(destination.name, contents);
      disk.files.delete(this.name);
      this.name = destination.name;
      return Promise.resolve();
    }
  }
  return { Directory, File, Paths: { document: 'document' } };
});

import { fileStore } from './outbox-storage';

const NAME = 'outbox-hosted_u1.json';
const TMP = `${NAME}.tmp`;

beforeEach(() => {
  disk.files.clear();
  disk.failMove = false;
});

describe('fileStore', () => {
  it('loads nothing when nothing is saved', async () => {
    await expect(fileStore('outbox', 'hosted_u1').load()).resolves.toBeUndefined();
  });

  it('save after save keeps only the newest, with no temporary file left', async () => {
    const store = fileStore('outbox', 'hosted_u1');
    await store.save({ n: 1 });
    await store.save({ n: 2 });
    await expect(store.load()).resolves.toEqual({ n: 2 });
    expect([...disk.files.keys()]).toEqual([NAME]);
  });

  it('a save cut short before the move still loads the new value', async () => {
    const store = fileStore('outbox', 'hosted_u1');
    await store.save({ n: 1 });
    disk.failMove = true;
    await expect(store.save({ n: 2 })).rejects.toThrow();
    // The old file is untouched; the new value sits in the temporary file.
    expect(disk.files.get(NAME)).toBe('{"n":1}');
    disk.failMove = false;
    disk.files.delete(NAME); // The move removed the old file, then the app was killed.
    await expect(store.load()).resolves.toEqual({ n: 2 });
  });

  it('a corrupt saved file with a good temporary file loads the temporary one', async () => {
    disk.files.set(NAME, '{"n":');
    disk.files.set(TMP, '{"n":3}');
    await expect(fileStore('outbox', 'hosted_u1').load()).resolves.toEqual({ n: 3 });
  });

  it('a corrupt saved file and no temporary file still throws', async () => {
    disk.files.set(NAME, '{"n":');
    await expect(fileStore('outbox', 'hosted_u1').load()).rejects.toThrow();
  });

  it('a corrupt saved file and a corrupt temporary file still throws', async () => {
    disk.files.set(NAME, '{"n":');
    disk.files.set(TMP, 'nope');
    await expect(fileStore('outbox', 'hosted_u1').load()).rejects.toThrow();
  });

  it('remove clears the saved and the temporary file', async () => {
    disk.files.set(NAME, '{"n":1}');
    disk.files.set(TMP, '{"n":2}');
    await fileStore('outbox', 'hosted_u1').remove();
    expect(disk.files.size).toBe(0);
    await expect(fileStore('outbox', 'hosted_u1').load()).resolves.toBeUndefined();
  });
});
