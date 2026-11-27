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
  /**
   * Where a saved copy is now: `uri` itself, or the same copy under today's document folder (iOS
   * moves the app's folder on an update). Undefined when neither exists.
   */
  locate?(uri: string): string | undefined;
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

/**
 * A kept copy's uri moved under `currentDocumentUri`: `.../outbox/<clientId>/<file>` keeps its
 * last three segments. Undefined for a uri that is not a kept copy.
 */
export function rebaseOutboxUri(savedUri: string, currentDocumentUri: string): string | undefined {
  const marker = `/${OUTBOX_FOLDER}/`;
  const at = savedUri.lastIndexOf(marker);
  if (at < 0 || currentDocumentUri === '') return undefined;
  const tail = savedUri.slice(at + 1);
  if (!/^outbox\/[^/]+\/[^/]+$/.test(tail)) return undefined;
  return `${currentDocumentUri.replace(/\/+$/, '')}/${tail}`;
}

/**
 * `<document>/chat-state/<kind>-<scope>.json`. A save writes `<name>.json.tmp` first and then
 * moves it over the saved file, so an app killed mid-write never leaves a half-written file.
 */
export function fileStore(
  kind: 'outbox' | 'drafts' | 'private' | 'agents',
  scope: string,
): JsonStore {
  const files = async () => {
    const { Directory, File, Paths } = await import('expo-file-system');
    const folder = new Directory(Paths.document, STATE_FOLDER);
    const name = `${kind}-${scope}.json`;
    return { folder, target: new File(folder, name), tmp: new File(folder, `${name}.tmp`) };
  };
  return {
    async load() {
      const { target, tmp } = await files();
      let failure: Error | undefined;
      if (target.exists) {
        try {
          return JSON.parse(await target.text()) as unknown;
        } catch (error) {
          failure = error instanceof Error ? error : new Error('Unreadable saved file');
        }
      }
      // A save cut short may have left only the new value in the temporary file.
      if (tmp.exists) {
        try {
          return JSON.parse(await tmp.text()) as unknown;
        } catch {
          /* Fall through to the saved file's outcome. */
        }
      }
      if (failure !== undefined) throw failure;
      return undefined;
    },
    async save(value) {
      const { folder, target, tmp } = await files();
      if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
      tmp.write(JSON.stringify(value));
      await tmp.move(target, { overwrite: true });
    },
    async remove() {
      const { target, tmp } = await files();
      if (target.exists) target.delete();
      if (tmp.exists) tmp.delete();
    },
  };
}

/** Files under `<document>/outbox/<clientId>/`. */
export async function deviceOutboxFiles(): Promise<OutboxFiles> {
  const { Directory, File, Paths } = await import('expo-file-system');
  const exists = (uri: string) => {
    try {
      return new File(uri).exists;
    } catch {
      return false;
    }
  };
  return {
    async keep(clientId, uri, key) {
      const folder = new Directory(Paths.document, OUTBOX_FOLDER, clientId);
      if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
      const source = new File(uri);
      const copy = new File(folder, key ? `${key}-${source.name}` : source.name);
      await source.copy(copy, { overwrite: true });
      return copy.uri;
    },
    exists,
    locate(uri) {
      if (exists(uri)) return uri;
      const moved = rebaseOutboxUri(uri, Paths.document.uri);
      return moved !== undefined && moved !== uri && exists(moved) ? moved : undefined;
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
