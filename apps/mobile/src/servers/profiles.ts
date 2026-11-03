import { chunkedSecureStorage, type SecureKeyValue } from '../auth/storage';

/** Twring's built-in service, or a server the person runs themselves (added by pairing). */
export type ServerProfile =
  | { kind: 'hosted' }
  | {
      kind: 'selfhost';
      serverId: string;
      /** https://host[:port], normalized. */
      address: string;
      /** The server's display name. */
      name: string;
      /** Pinned Ed25519 key, base64url. */
      publicKey: string;
      person: { id: string; displayName: string; role: 'admin' | 'member' };
      deviceId: string;
      audio: 'own' | 'twring';
    };
export type SelfhostProfile = Extract<ServerProfile, { kind: 'selfhost' }>;

/** Per-server secrets (base64url). Kept apart from the profile list and never logged. */
export interface ProfileSecrets {
  deviceToken: string;
  sealKey: string;
}

export interface ProfileStore {
  /** Once at start; tolerates corrupt data (resets to hosted, logs no values). */
  load(): Promise<void>;
  /** Hosted until load() finds a saved active self-hosted profile. */
  active(): ServerProfile;
  /** Saved self-hosted profiles. */
  list(): readonly ServerProfile[];
  save(profile: SelfhostProfile, secrets: ProfileSecrets): Promise<void>;
  secrets(serverId: string): Promise<ProfileSecrets | undefined>;
  activate(serverId: string): Promise<void>;
  /** Profile and secrets; the active server falls back to hosted. */
  remove(serverId: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

const LIST_KEY = 'twring.servers';
const ACTIVE_KEY = 'twring.servers.active';
const tokenKey = (serverId: string) => `twring.server.${serverId}.token`;
const sealKey = (serverId: string) => `twring.server.${serverId}.seal`;

const HOSTED: ServerProfile = { kind: 'hosted' };

function isSelfhost(value: unknown): value is SelfhostProfile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const person = v.person as Record<string, unknown> | null | undefined;
  return (
    v.kind === 'selfhost' &&
    typeof v.serverId === 'string' &&
    typeof v.address === 'string' &&
    typeof v.name === 'string' &&
    typeof v.publicKey === 'string' &&
    typeof v.deviceId === 'string' &&
    (v.audio === 'own' || v.audio === 'twring') &&
    typeof person === 'object' &&
    person !== null &&
    typeof person.id === 'string' &&
    typeof person.displayName === 'string' &&
    (person.role === 'admin' || person.role === 'member')
  );
}

/** A stored list that does not parse, or has a bad entry, loads as empty. Never logs the text. */
function parseList(raw: string | null): SelfhostProfile[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isSelfhost)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function createProfileStore(storage: SecureKeyValue): ProfileStore {
  const list = chunkedSecureStorage(storage);
  let profiles: SelfhostProfile[] = [];
  let active: ServerProfile = HOSTED;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  const writeList = () => list.setItem(LIST_KEY, JSON.stringify(profiles));

  return {
    async load() {
      profiles = parseList(await list.getItem(LIST_KEY).catch(() => null));
      const id = await storage.getItemAsync(ACTIVE_KEY).catch(() => null);
      const loaded = profiles.find((p) => p.serverId === id) ?? HOSTED;
      // Hosted users see no change at start: nothing downstream resets for them.
      const changed = loaded !== active;
      active = loaded;
      if (changed) emit();
    },
    active: () => active,
    list: () => profiles,
    async save(profile, secrets) {
      // Secrets first: a profile without its token would be unusable.
      await storage.setItemAsync(tokenKey(profile.serverId), secrets.deviceToken);
      await storage.setItemAsync(sealKey(profile.serverId), secrets.sealKey);
      const next = profiles.filter((p) => p.serverId !== profile.serverId);
      next.push(profile);
      profiles = next;
      await writeList();
      if (active.kind === 'selfhost' && active.serverId === profile.serverId) active = profile;
      emit();
    },
    async secrets(serverId) {
      const deviceToken = await storage.getItemAsync(tokenKey(serverId));
      const seal = await storage.getItemAsync(sealKey(serverId));
      if (deviceToken === null || seal === null) return undefined;
      return { deviceToken, sealKey: seal };
    },
    async activate(serverId) {
      const next =
        serverId === 'hosted' ? HOSTED : (profiles.find((p) => p.serverId === serverId) ?? HOSTED);
      await storage.setItemAsync(ACTIVE_KEY, next.kind === 'hosted' ? 'hosted' : next.serverId);
      if (next === active) return;
      active = next;
      emit();
    },
    async remove(serverId) {
      const wasActive = active.kind === 'selfhost' && active.serverId === serverId;
      profiles = profiles.filter((p) => p.serverId !== serverId);
      await writeList();
      await storage.deleteItemAsync(tokenKey(serverId));
      await storage.deleteItemAsync(sealKey(serverId));
      if (wasActive) {
        active = HOSTED;
        await storage.setItemAsync(ACTIVE_KEY, 'hosted');
      }
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The app keychain, loaded on first use: modules that only read the active server's address (and
 * their tests) must not pull in the native secure-store module at import.
 */
const keychain: SecureKeyValue = {
  getItemAsync: async (key) =>
    (await import('../platform/secure-store')).secureStore.getItemAsync(key),
  setItemAsync: async (key, value) =>
    (await import('../platform/secure-store')).secureStore.setItemAsync(key, value),
  deleteItemAsync: async (key) =>
    (await import('../platform/secure-store')).secureStore.deleteItemAsync(key),
};

export const profileStore: ProfileStore = createProfileStore(keychain);
