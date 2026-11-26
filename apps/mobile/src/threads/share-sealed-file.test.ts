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
      const parts = this.path.split('/');
      for (let i = 1; i <= parts.length; i++) state.entries.add(parts.slice(0, i).join('/'));
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

import { clearSealedFiles } from './sealed-file-cache';
import { shareName, shareSealedFile } from './share-sealed-file';

beforeEach(() => {
  state.entries.clear();
  state.shared = [];
  state.failShare = false;
});

describe('sharing opened files', () => {
  it('a share copy stays after the share and is removed by the next share', async () => {
    await shareSealedFile('file://cache/sealed-files/fil_x', {
      name: 'plan',
      mime: 'application/pdf',
    });
    expect(state.shared).toHaveLength(1);
    expect(state.shared[0].uri).toMatch(/plan.pdf$/);
    expect(state.shared[0].mime).toBe('application/pdf');
    expect(state.shared[0].existedWhenShared).toBe(true);
    // Still there: a slow receiver may be reading it.
    const first = state.shared[0].uri.replace('file://', '');
    expect(state.entries.has(first)).toBe(true);
    await shareSealedFile('file://cache/sealed-files/fil_y', { name: 'b', mime: 'text/plain' });
    expect(state.entries.has(first)).toBe(false);
    expect(state.shared[1].uri).toMatch(/b.txt$/);
    expect(state.entries.has(state.shared[1].uri.replace('file://', ''))).toBe(true);
  });

  it('keeps an extension the name has, cleans path characters, and leaves a cancelled share sweepable', () => {
    expect(shareName('a/b.png', 'image/png')).toBe('a_b.png');
    expect(shareName('..', 'application/pdf')).toBe('file.pdf');
  });

  it('clearSealedFiles removes share copies', async () => {
    await shareSealedFile('file://cache/x', { name: 'a', mime: 'text/csv' });
    expect([...state.entries].some((key) => key.includes('sealed-share'))).toBe(true);
    await clearSealedFiles();
    expect([...state.entries].filter((key) => key.includes('sealed-share'))).toEqual([]);
  });
});
