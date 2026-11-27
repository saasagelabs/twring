import { describe, expect, it } from 'vitest';

import type { SecureKeyValue } from '../auth/storage';
import {
  forgetListPreview,
  LIST_PREVIEW_CHARS,
  LIST_PREVIEWS_KEY,
  loadListPreviews,
  saveListPreview,
} from './list-previews';
import { forgetPrivateDevice } from './private-chats';

function memory(): SecureKeyValue & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItemAsync: (key) => Promise.resolve(map.get(key) ?? null),
    setItemAsync: (key, value) => Promise.resolve(void map.set(key, value)),
    deleteItemAsync: (key) => Promise.resolve(void map.delete(key)),
  };
}

const a1 = 'agt_' + 'a'.repeat(20);
const a2 = 'agt_' + 'b'.repeat(20);

describe('Chats list previews of private chats', () => {
  it('keeps at most a short line per chat, by message id', async () => {
    const store = memory();
    await saveListPreview(store, a1, { messageId: 'm1', text: 'x'.repeat(500) });
    await saveListPreview(store, a2, { messageId: 'm2', text: 'hello\n  there' });
    const saved = await loadListPreviews(store);
    expect(saved.get(a1)?.text).toHaveLength(LIST_PREVIEW_CHARS);
    expect(saved.get(a2)).toEqual({ messageId: 'm2', text: 'hello there' });
    expect([...store.map.values()].join('')).not.toContain('x'.repeat(LIST_PREVIEW_CHARS + 1));
    await forgetListPreview(store, a1);
    expect([...(await loadListPreviews(store)).keys()]).toEqual([a2]);
  });

  it('goes with the private keys, and a write racing sign-out is not saved', async () => {
    const store = memory();
    await saveListPreview(store, a1, { messageId: 'm1', text: 'secret' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const get = (key: string) => store.map.get(key) ?? null;
    store.getItemAsync = async (key) => {
      await gate;
      return get(key);
    };
    const saving = saveListPreview(store, a2, { messageId: 'm2', text: 'other' });
    const forgetting = forgetPrivateDevice(store);
    release();
    await Promise.all([saving, forgetting]);
    expect(store.map.has(LIST_PREVIEWS_KEY)).toBe(false);
    expect([...store.map.values()].join('')).not.toMatch(/secret|other/);
  });

  it('anything unreadable shows nothing', async () => {
    const store = memory();
    store.map.set(LIST_PREVIEWS_KEY, 'not json');
    expect((await loadListPreviews(store)).size).toBe(0);
    store.map.set(LIST_PREVIEWS_KEY, JSON.stringify([a1, 'bad id']));
    store.map.set(`twring.e2e.list_preview.v1.${a1}`, '{"text":3}');
    expect((await loadListPreviews(store)).size).toBe(0);
  });
});
