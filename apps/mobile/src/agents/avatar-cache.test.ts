import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ files: new Set<string>(), downloads: [] as string[] }));
vi.mock('expo-file-system', () => {
  class Directory {
    constructor(..._parts: unknown[]) {}
    list() {
      return [...state.files].map((name) => new File(this, name));
    }
  }
  class File {
    name: string;
    uri: string;
    constructor(_directory: Directory, name: string) {
      this.name = name;
      this.uri = `file:///${name}`;
    }
    get exists() {
      return state.files.has(this.name);
    }
    delete() {
      state.files.delete(this.name);
    }
    static downloadFileAsync(_uri: string, file: File) {
      state.downloads.push(file.name);
      state.files.add(file.name);
      return Promise.resolve(file);
    }
  }
  return { Directory, File, Paths: { cache: 'cache' } };
});

import { cachedAgentAvatar } from './avatar-cache';

const id = `agt_${'a'.repeat(20)}`;
const api = {
  agentAvatarUrl: vi.fn(() =>
    Promise.resolve({
      uri: 'https://example.com/photo',
      headers: { authorization: 'Bearer test' },
    }),
  ),
};
beforeEach(() => {
  state.files.clear();
  state.downloads.length = 0;
  api.agentAvatarUrl.mockClear();
});

describe('avatar cache', () => {
  it('downloads on a miss and reuses the cached version', async () => {
    const uri = await cachedAgentAvatar(api, id, 1);
    expect(uri).toBe(`file:///avatar-${id}-1.jpg`);
    expect(await cachedAgentAvatar(api, id, 1)).toBe(uri);
    expect(state.downloads).toEqual([`avatar-${id}-1.jpg`]);
  });
  it('removes older versions only after the replacement is cached', async () => {
    state.files.add(`avatar-${id}-1.jpg`);
    state.files.add('avatar-agt_bbbbbbbbbbbbbbbbbbbb-1.jpg');
    await cachedAgentAvatar(api, id, 2);
    expect([...state.files].sort()).toEqual(
      [`avatar-${id}-2.jpg`, 'avatar-agt_bbbbbbbbbbbbbbbbbbbb-1.jpg'].sort(),
    );
  });
});
