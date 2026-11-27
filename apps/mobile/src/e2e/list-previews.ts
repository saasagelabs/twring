import type { SecureKeyValue } from '../auth/storage';
import { writeWhileKept } from './approve';

/**
 * The Chats list's line for a private chat (owner, 2026-11-27): a short opened preview of the
 * last message, so a cold start shows it at once. It lives only in the signed-in account's private
 * keychain (device-only), one entry per chat, and goes with the private keys
 * (`forgetPrivateDevice`). Never the whole message, and never in a file.
 */
export const LIST_PREVIEWS_KEY = 'twring.e2e.list_previews.v1';
const entryKey = (agentId: string) => `twring.e2e.list_preview.v1.${agentId}`;
/** The most characters kept per chat. */
export const LIST_PREVIEW_CHARS = 120;
/** The oldest chats go first past this many, as voice-note consent does. */
export const LIST_PREVIEWS_CAP = 60;

export interface ListPreview {
  messageId: string;
  text: string;
}

/** Cut to the cap on a whole character, one line. */
export function previewText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length <= LIST_PREVIEW_CHARS
    ? line
    : chars.slice(0, LIST_PREVIEW_CHARS).join('').trimEnd();
}

function parseIds(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string' && /^agt_[a-z0-9]{20}$/.test(id))
      : [];
  } catch {
    return [];
  }
}

function parseEntry(raw: string | null): ListPreview | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<ListPreview> | null;
    if (typeof value?.messageId !== 'string' || typeof value.text !== 'string') return undefined;
    return { messageId: value.messageId, text: previewText(value.text) };
  } catch {
    return undefined;
  }
}

const readIds = async (store: SecureKeyValue) =>
  parseIds(await store.getItemAsync(LIST_PREVIEWS_KEY));

/** Every saved preview by chat; anything unreadable is left out. */
export async function loadListPreviews(store: SecureKeyValue): Promise<Map<string, ListPreview>> {
  const found = new Map<string, ListPreview>();
  try {
    for (const agentId of await readIds(store)) {
      const entry = parseEntry(await store.getItemAsync(entryKey(agentId)).catch(() => null));
      if (entry !== undefined) found.set(agentId, entry);
    }
  } catch {
    // Nothing saved is shown.
  }
  return found;
}

/** Ordered against sign-out: a preview still being written then is not saved after the keys go. */
export async function saveListPreview(
  store: SecureKeyValue,
  agentId: string,
  preview: ListPreview,
): Promise<void> {
  await writeWhileKept(store, async () => {
    const ids = (await readIds(store).catch(() => [])).filter((id) => id !== agentId);
    ids.push(agentId);
    const kept = ids.slice(-LIST_PREVIEWS_CAP);
    await store.setItemAsync(
      entryKey(agentId),
      JSON.stringify({ messageId: preview.messageId, text: previewText(preview.text) }),
    );
    await store.setItemAsync(LIST_PREVIEWS_KEY, JSON.stringify(kept));
    await Promise.all(
      ids
        .slice(0, ids.length - kept.length)
        .map((id) => store.deleteItemAsync(entryKey(id)).catch(() => undefined)),
    );
  });
}

/** One chat's preview, after "Clear chat". */
export async function forgetListPreview(store: SecureKeyValue, agentId: string): Promise<void> {
  await writeWhileKept(store, async () => {
    await store.deleteItemAsync(entryKey(agentId));
    const ids = await readIds(store);
    if (ids.includes(agentId))
      await store.setItemAsync(
        LIST_PREVIEWS_KEY,
        JSON.stringify(ids.filter((id) => id !== agentId)),
      );
  });
}

/** Every preview, with the private keys (called inside `forgetPrivateDevice`). */
export async function forgetListPreviews(store: SecureKeyValue): Promise<void> {
  const ids = await readIds(store).catch(() => []);
  await Promise.all(ids.map((id) => store.deleteItemAsync(entryKey(id)).catch(() => undefined)));
  await store.deleteItemAsync(LIST_PREVIEWS_KEY).catch(() => undefined);
}
