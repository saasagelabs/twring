import type { SecureKeyValue } from '../auth/storage';

/**
 * Chats where the person said yes to voice notes going through Twring's server (owner,
 * 2026-11-27): asked once per private chat on this phone, before recording. One keychain entry in
 * the signed-in account's private keychain holds the agent ids; sign-out and making the chat
 * private again remove it.
 */
export const VOICE_CONSENT_KEY = 'twring.e2e.voice_consent.v1';
/** The oldest consents go first past this many chats. */
export const VOICE_CONSENT_CAP = 200;

function parse(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    if (!value.every((id): id is string => typeof id === 'string' && id.length > 0)) return [];
    return value;
  } catch {
    return [];
  }
}

async function read(store: SecureKeyValue): Promise<string[]> {
  return parse(await store.getItemAsync(VOICE_CONSENT_KEY));
}

/** Anything unreadable counts as no consent. */
export async function hasVoiceConsent(store: SecureKeyValue, agentId: string): Promise<boolean> {
  try {
    return (await read(store)).includes(agentId);
  } catch {
    return false;
  }
}

export async function giveVoiceConsent(store: SecureKeyValue, agentId: string): Promise<void> {
  const ids = (await read(store).catch(() => [])).filter((id) => id !== agentId);
  ids.push(agentId);
  await store.setItemAsync(VOICE_CONSENT_KEY, JSON.stringify(ids.slice(-VOICE_CONSENT_CAP)));
}

export async function clearVoiceConsent(store: SecureKeyValue, agentId: string): Promise<void> {
  const ids = await read(store);
  if (!ids.includes(agentId)) return;
  await store.setItemAsync(VOICE_CONSENT_KEY, JSON.stringify(ids.filter((id) => id !== agentId)));
}
