import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  entries: new Set<string>(),
  shared: [] as { uri: string; mime?: string; existedWhenShared: boolean }[],
  failShare: false,
}));
vi.mock('expo-file-system', () => {
  const path = (parent: unknown, name?: string) =>
    name === undefined ? String(parent) : `${(parent as { path: string }).path}/${name}`;
  class Directory {
    path: string;
    constructor(parent: unknown, name?: string) {
      this.path = path(parent, name);
    }
    get exists() {
      return state.entries.has(this.path);
    }
    create() {
      state.entries.add(this.path);
    }
    delete() {
      for (const key of [...state.entries])
        if (key === this.path || key.startsWith(`${this.path}/`)) state.entries.delete(key);
    }
  }
  class File {
    path: string;
    constructor(parent: unknown, name?: string) {
      this.path = path(parent, name);
    }
    get uri() {
      return `file://${this.path}`;
    }
    copy(to: File) {
      state.entries.add(to.path);
    }
  }
  return { Directory, File, Paths: { cache: 'cache' } };
});
vi.mock('expo-sharing', () => ({
  shareAsync: (uri: string, options: { mimeType?: string }) => {
    state.shared.push({
      uri,
      mime: options.mimeType,
      existedWhenShared: state.entries.has(uri.replace('file://', '')),
    });
    return state.failShare ? Promise.reject(new Error('cancel')) : Promise.resolve();
  },
}));

import { shareName, shareSealedFile } from './share-sealed-file';

beforeEach(() => {
  state.entries.clear();
  state.shared = [];
  state.failShare = false;
});

describe('sharing opened files', () => {
  it('sharing a sealed PDF uses its name with an extension and removes the copy', async () => {
    await shareSealedFile('file://cache/sealed-files/fil_x', {
      name: 'plan',
      mime: 'application/pdf',
    });
    expect(state.shared).toHaveLength(1);
    expect(state.shared[0].uri).toMatch(/\/plan\.pdf$/);
    expect(state.shared[0].mime).toBe('application/pdf');
    expect(state.shared[0].existedWhenShared).toBe(true);
    expect([...state.entries]).toEqual([]);
  });

  it('removes the copy when the share fails, and keeps an extension the name has', async () => {
    state.failShare = true;
    await expect(
      shareSealedFile('file://cache/x', { name: 'a/b.png', mime: 'image/png' }),
    ).rejects.toThrow();
    expect([...state.entries]).toEqual([]);
    expect(shareName('a/b.png', 'image/png')).toBe('a_b.png');
    expect(shareName('..', 'application/pdf')).toBe('file.pdf');
  });
});
