/**
 * Where unsent chat messages and composer drafts are kept between launches: one JSON value per
 * file under the app's document directory, named by the signed-in account and server so another
 * account never sees (or sends) an old account's messages.
 */
export interface JsonStore {
  /** The saved value, or undefined when there is none. Throws only on an unreadable file. */
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
  remove(): Promise<void>;
}

/** Copies of queued voice notes and files, so a restart can still send them. */
export interface OutboxFiles {
  /**
   * Copies `uri` into the message's own folder and returns the copy's uri. `key`, when given,
   * prefixes the copy's name so two files with the same name stay apart.
   */
  keep(clientId: string, uri: string, key?: string): Promise<string>;
  exists(uri: string): boolean;
  remove(uri: string): void;
}

/** For tests and for a session with no signed-in account: nothing outlives the process. */
export function memoryStore(): JsonStore & { value: unknown; saves: number } {
  const store = {
    value: undefined as unknown,
    saves: 0,
    load: () => Promise.resolve(store.value),
    save: (value: unknown) => {
      store.saves += 1;
      store.value = JSON.parse(JSON.stringify(value)) as unknown;
      return Promise.resolve();
    },
    remove: () => {
      store.value = undefined;
      return Promise.resolve();
    },
  };
  return store;
}

/**
 * The account and server the chat state belongs to, safe as a file name: `hosted_<userId>` or
 * `selfhost_<serverId>_<personId>`.
 */
export function storageScope(
  server: { kind: 'hosted' } | { kind: 'selfhost'; serverId: string; personId: string },
  userId: string | undefined,
): string | undefined {
  const parts =
    server.kind === 'hosted'
      ? userId
        ? ['hosted', userId]
        : undefined
      : ['selfhost', server.serverId, server.personId];
  return parts?.map((part) => part.replace(/[^A-Za-z0-9-]/g, '_')).join('_');
}

const STATE_FOLDER = 'chat-state';
const OUTBOX_FOLDER = 'outbox';

/** `<document>/chat-state/<kind>-<scope>.json`. */
export function fileStore(kind: 'outbox' | 'drafts' | 'private', scope: string): JsonStore {
  const file = async () => {
    const { Directory, File, Paths } = await import('expo-file-system');
    const folder = new Directory(Paths.document, STATE_FOLDER);
    return { folder, file: new File(folder, `${kind}-${scope}.json`) };
  };
  return {
    async load() {
      const { file: target } = await file();
      if (!target.exists) return undefined;
      return JSON.parse(await target.text()) as unknown;
    },
    async save(value) {
      const { folder, file: target } = await file();
      if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
      target.write(JSON.stringify(value));
    },
    async remove() {
      const { file: target } = await file();
      if (target.exists) target.delete();
    },
  };
}

/** Files under `<document>/outbox/<clientId>/`. */
export async function deviceOutboxFiles(): Promise<OutboxFiles> {
  const { Directory, File, Paths } = await import('expo-file-system');
  return {
    async keep(clientId, uri, key) {
      const folder = new Directory(Paths.document, OUTBOX_FOLDER, clientId);
      if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
      const source = new File(uri);
      const copy = new File(folder, key ? `${key}-${source.name}` : source.name);
      await source.copy(copy, { overwrite: true });
      return copy.uri;
    },
    exists(uri) {
      try {
        return new File(uri).exists;
      } catch {
        return false;
      }
    },
    remove(uri) {
      try {
        const file = new File(uri);
        const parent = file.parentDirectory;
        if (file.exists) file.delete();
        // A kept copy's folder is named by the message; drop it once empty.
        if (parent.name !== OUTBOX_FOLDER && parent.parentDirectory.name === OUTBOX_FOLDER) {
          if (parent.exists && parent.list().length === 0) parent.delete();
        }
      } catch {
        /* A temporary recording may already be gone. */
      }
    },
  };
}
