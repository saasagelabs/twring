import {
  MAX_FILE_BYTES,
  sealedEnvelopeV1Schema,
  type Attachment,
  type SealedEnvelopeV1,
  type SealedPayload,
  type ThreadMessage,
} from '@twring/contracts';
import { z } from 'zod';

import { ApiError } from '../api/client';
import { callDuration } from './presentation';
import type { PreparedFile } from './files';
import { deviceOutboxFiles, type JsonStore, type OutboxFiles } from './outbox-storage';

export interface PendingMessage {
  clientId: string;
  agentId: string;
  text: string;
  state: 'sending' | 'failed';
  createdAt: string;
  voice?: OutboxVoice;
  files?: PreparedFile[];
  /** The message this one answers; dropped if that message is deleted before this goes out. */
  replyTo?: string;
  error?: unknown;
  /** A stable machine code for a failure with no error object (a file lost over a restart). */
  errorCode?: string;
  /**
   * A private chat's message (ADR-044), sealed once and resent as is. Only this reaches the disk;
   * `text` stays in memory.
   */
  sealed?: SealedEnvelopeV1;
  /** Sent in a private chat: its text is never saved, and it is never sent as text. */
  privateChat?: true;
}

/**
 * How the outbox seals for private chats. `known` answers from what is already loaded;
 * `isPrivate` may wait for the chat list.
 */
export interface OutboxSealer {
  known(agentId: string): boolean;
  isPrivate(agentId: string): Promise<boolean>;
  /** Throws an error with a stable `code` when it cannot seal. */
  /** `replyTo`: the answered message, quoted inside the sealed payload. `files`: the uploaded files. */
  seal(
    agentId: string,
    text: string,
    replyTo?: string,
    files?: SealedPayload['files'],
  ): Promise<SealedEnvelopeV1>;
  /** Reads a file and seals it with a fresh key (ADR-045); throws an error with a stable `code`. */
  sealFile(agentId: string, file: PreparedFile): Promise<{ blob: Uint8Array; key: string }>;
  /** Uploads a sealed blob; `clientId` is the file's own, so a resend never stores it twice. */
  uploadSealed(
    agentId: string,
    file: { clientId: string; bytes: Uint8Array },
    signal: AbortSignal,
  ): Promise<{ id: string }>;
  /** Keeps the sent file's copy under its server id, so this phone never downloads it. */
  cacheOwnFile(fileId: string, localUri: string): Promise<void>;
  openOwn(agentId: string, sealed: SealedEnvelopeV1): Promise<string | undefined>;
}
export interface OutboxVoice {
  uri: string;
  durationMs: number;
  /**
   * Set only when the person chose "Send anyway" in a private chat: the server may read this
   * voice note. Without it a private chat's server refuses the note (409 `private_thread`).
   */
  serverReadable?: true;
}

/** Saved by an older build, which refused files in a private chat. */
export const PRIVATE_FILES = 'private_files';
/** A private file message restored after the app closed before its envelope was saved (ADR-045). */
export const PRIVATE_UNSENT = 'private_unsent';
/** The server refused something that reached a private chat unsealed (a voice note without consent). */
export const PRIVATE_THREAD = 'private_thread';

/** At most this many queued messages are saved for the next launch, newest kept. */
export const OUTBOX_LIMIT = 50;
const SAVE_DEBOUNCE_MS = 300;
/** A queued voice note or file was no longer on the phone after a restart. */
export const FILE_MISSING = 'file_missing';
/** A queued voice note's recording could not be read (gone, or its folder moved out of reach). */
export const VOICE_MISSING = 'voice_missing';
/** Failures that may clear by themselves: a restart sends these again. */
const TEMPORARY_FAILURES: readonly string[] = [
  'network',
  'timeout',
  'rate_limited',
  'agent_offline',
];

const storedUri = z.string().min(1).max(2_000);
const storedOutbox = z.object({
  version: z.literal(1),
  items: z
    .array(
      z.object({
        clientId: z.string().min(1).max(100),
        agentId: z.string().min(1).max(100),
        text: z.string().max(20_000),
        sealed: sealedEnvelopeV1Schema.optional(),
        /** A private file message not yet sealed: no text is saved, it comes back failed. */
        privateChat: z.literal(true).optional(),
        state: z.enum(['sending', 'failed']),
        createdAt: z.string().max(100),
        voice: z
          .object({
            uri: storedUri,
            durationMs: z.number().nonnegative(),
            serverReadable: z.literal(true).optional(),
          })
          .optional(),
        files: z
          .array(
            z.object({
              clientId: z.string().min(1).max(100),
              uri: storedUri,
              name: z.string().max(500),
              mimeType: z.string().max(200),
              sizeBytes: z.number().nonnegative(),
              width: z.number().optional(),
              height: z.number().optional(),
              sealedUpload: z
                .object({ id: z.string().min(1).max(64), key: z.string().max(64) })
                .optional(),
            }),
          )
          .max(20)
          .optional(),
        errorCode: z.string().max(100).optional(),
        // Missing in queues saved before replies existed.
        replyTo: z.string().min(1).max(100).optional(),
      }),
    )
    .max(OUTBOX_LIMIT),
});

/** A stable code for a failure, never the error object (it can hold request details). */
function errorCodeOf(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  if (error instanceof ApiError) return error.code ?? error.kind;
  return 'unknown';
}

/**
 * Failures a retry cannot fix (private-chat codes from `SealError`, and file limits): the
 * person gets Delete and sends again. `seal_failed` stays retryable.
 */
const NOT_RETRYABLE: ReadonlySet<string> = new Set([
  'pair_again',
  'not_computer',
  'too_long',
  'file_too_large',
  'unsupported_file_type',
]);

/**
 * False when sending again cannot help: the message's text or file is gone, or a private chat
 * refuses a voice note the person has not agreed to let the server read. Delete is offered then.
 */
export function canRetry(pending: {
  errorCode?: string;
  error?: unknown;
  voice?: { serverReadable?: true };
}): boolean {
  const code = pending.errorCode ?? errorCodeOf(pending.error);
  if (code === PRIVATE_UNSENT || code === FILE_MISSING || code === VOICE_MISSING) return false;
  if (code !== undefined && NOT_RETRYABLE.has(code)) return false;
  if (code === PRIVATE_THREAD && pending.voice && pending.voice.serverReadable !== true)
    return false;
  return true;
}

/** Where a saved copy is now (see `OutboxFiles.locate`). */
function locateFile(files: OutboxFiles | undefined, uri: string): string | undefined {
  if (!files) return undefined;
  if (files.locate) return files.locate(uri);
  return files.exists(uri) ? uri : undefined;
}

export interface OutboxPersistence {
  store: JsonStore;
  files?: () => Promise<OutboxFiles>;
}

export function newClientId(): string {
  // Hermes has no Web Crypto. The id is only a resend key (the server dedupes on it), not a
  // secret, so Math.random is enough here, as for the push device id.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface OutboxTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  now(): number;
}

export const systemTimers: OutboxTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class Outbox {
  private readonly items = new Map<string, PendingMessage>();
  /**
   * A private file sealed once, by the file's client id, until its upload succeeds. The gateway
   * keeps the first blob it stored for a client id, so a retry must send that same blob and key
   * (a new key would name a file the computer cannot open). Memory only: after a restart the
   * item becomes `private_unsent`.
   */
  private readonly sealedBlobs = new Map<string, { blob: Uint8Array; key: string }>();
  private readonly waits = new Set<() => void>();
  private readonly controllers = new Set<AbortController>();
  private readonly store?: JsonStore;
  private readonly files: () => Promise<OutboxFiles>;
  private filesPromise?: Promise<OutboxFiles>;
  private loaded = false;
  private disposed = false;
  private saveTimer: unknown;
  private saving: Promise<void> = Promise.resolve();
  /** Resolves once the saved queue (if any) is back in memory and resending. */
  readonly hydrated: Promise<void>;

  constructor(
    private readonly sendRequest: (
      agentId: string,
      message: {
        clientId: string;
        text: string;
        sealed?: SealedEnvelopeV1;
        voice?: OutboxVoice;
        attachmentIds?: string[];
        replyTo?: string;
      },
      signal: AbortSignal,
    ) => Promise<ThreadMessage>,
    private readonly changed: () => void,
    private readonly timers: OutboxTimers = systemTimers,
    private readonly upload?: (
      agentId: string,
      file: PreparedFile,
      signal: AbortSignal,
    ) => Promise<Attachment>,
    persistence?: OutboxPersistence,
    private readonly sealer?: OutboxSealer,
  ) {
    this.store = persistence?.store;
    const files = persistence?.files ?? deviceOutboxFiles;
    this.files = () => (this.filesPromise ??= files());
    // Nothing is saved until the saved queue is read, or an early save would overwrite it.
    this.hydrated = this.store ? this.hydrate(this.store) : Promise.resolve();
  }

  list(agentId: string): PendingMessage[] {
    return [...this.items.values()].filter((item) => item.agentId === agentId);
  }

  send(agentId: string, text: string, replyTo?: string): string {
    const clientId = newClientId();
    this.items.set(clientId, {
      clientId,
      agentId,
      text,
      ...(this.sealer?.known(agentId) === true && { privateChat: true as const }),
      ...(replyTo !== undefined && { replyTo }),
      state: 'sending',
      createdAt: new Date().toISOString(),
    });
    this.notify();
    void this.attempt(clientId);
    return clientId;
  }

  sendFiles(agentId: string, text: string, files: PreparedFile[], replyTo?: string): string {
    const clientId = newClientId();
    this.items.set(clientId, {
      clientId,
      agentId,
      text,
      ...(replyTo !== undefined && { replyTo }),
      files: files.map((file) => ({ ...file })),
      ...(this.sealer?.known(agentId) === true && { privateChat: true as const }),
      state: 'sending',
      createdAt: new Date().toISOString(),
    });
    this.start(clientId);
    return clientId;
  }

  sendVoice(
    agentId: string,
    uri: string,
    durationMs: number,
    replyTo?: string,
    options?: { serverReadable?: boolean },
  ): string {
    const clientId = newClientId();
    this.items.set(clientId, {
      clientId,
      agentId,
      ...(replyTo !== undefined && { replyTo }),
      text: `Voice note · ${callDuration(Math.round(durationMs / 1000))} · Sending…`,
      state: 'sending',
      createdAt: new Date().toISOString(),
      voice: { uri, durationMs, ...(options?.serverReadable === true && { serverReadable: true }) },
    });
    this.start(clientId);
    return clientId;
  }

  retry(clientId: string): void {
    const item = this.items.get(clientId);
    if (!item || item.state !== 'failed') return;
    // Its text or file is gone, or the server will refuse it again: only Delete is left.
    if (!canRetry(item)) return;
    this.items.set(clientId, { ...item, state: 'sending', error: undefined, errorCode: undefined });
    this.notify();
    void this.attempt(clientId);
  }

  private dropSealedBlobs(item: PendingMessage): void {
    for (const file of item.files ?? []) this.sealedBlobs.delete(file.clientId);
  }

  /** Removes a failed message from this phone only (it never reached the server), with its files. */
  discard(clientId: string): void {
    const item = this.items.get(clientId);
    if (!item || item.state !== 'failed') return;
    this.items.delete(clientId);
    this.dropSealedBlobs(item);
    if (item.voice) this.removeFile(item.voice.uri);
    for (const file of item.files ?? []) this.removeFile(file.uri);
    this.notify();
    // Saved at once: iOS may suspend the app before a debounced save, and the message come back.
    void this.flush();
  }

  reconcile(message: ThreadMessage): void {
    if (message.kind !== 'user_text' && message.kind !== 'sealed') return;
    if (message.client_id === undefined) return;
    const item = this.items.get(message.client_id);
    if (item?.agentId === message.agent_id) {
      this.items.delete(message.client_id);
      this.dropSealedBlobs(item);
      if (item.voice) this.removeFile(item.voice.uri);
      for (const file of item.files ?? []) this.removeFile(file.uri);
      this.notify();
    }
  }

  /**
   * Forgets every queued message: aborts sends and deletes their files and the saved queue
   * (sign-out). Resolves once storage is empty.
   */
  async clear(): Promise<void> {
    this.stopWork();
    for (const item of this.items.values()) {
      if (item.voice) this.removeFile(item.voice.uri);
      for (const file of item.files ?? []) this.removeFile(file.uri);
    }
    this.items.clear();
    this.sealedBlobs.clear();
    this.changed();
    const store = this.store;
    if (store) await this.saving.then(() => store.remove()).catch(() => undefined);
  }

  /**
   * Stops sending but keeps the saved queue and its files for the next launch on this account
   * (switching servers). Resolves once the latest queue is written.
   */
  async detach(): Promise<void> {
    // Stop first: a retry during the write would send under the next account's sign-in.
    const loaded = this.loaded;
    this.stopWork();
    const writing = loaded ? this.write() : this.saving;
    this.items.clear();
    this.sealedBlobs.clear();
    this.changed();
    await writing;
  }

  /**
   * "Clear chat": forgets one agent's queued messages, aborting their sends and deleting their
   * kept files, so nothing reaches the cleared chat afterwards.
   */
  forgetAgent(agentId: string): Promise<void> {
    for (const item of [...this.items.values()]) {
      if (item.agentId !== agentId) continue;
      this.items.delete(item.clientId);
      this.dropSealedBlobs(item);
      if (item.voice) this.removeFile(item.voice.uri);
      for (const file of item.files ?? []) this.removeFile(file.uri);
    }
    this.changed();
    return this.flush();
  }

  /** Writes the queue now, replacing a pending debounced write. */
  flush(): Promise<void> {
    if (this.saveTimer !== undefined) this.timers.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.loaded || this.disposed) return this.saving;
    return this.write();
  }

  private write(): Promise<void> {
    const store = this.store;
    if (!store) return this.saving;
    // A private chat's message is saved only once sealed, and then only sealed: never its text.
    // One with files is saved earlier, without text, so its uploaded files can be told apart.
    const kept = [...this.items.values()].filter(
      (item) =>
        item.sealed !== undefined || item.privateChat !== true || (item.files?.length ?? 0) > 0,
    );
    const items = kept.slice(-OUTBOX_LIMIT).map((item) => {
      const errorCode = item.errorCode ?? errorCodeOf(item.error);
      return {
        clientId: item.clientId,
        agentId: item.agentId,
        text: item.sealed !== undefined || item.privateChat === true ? '' : item.text,
        ...(item.sealed !== undefined && { sealed: item.sealed }),
        ...(item.sealed === undefined &&
          item.privateChat === true && { privateChat: true as const }),
        state: item.state,
        createdAt: item.createdAt,
        ...(item.voice && { voice: item.voice }),
        // An upload is redone after a restart under the same file clientId.
        ...(item.files?.length && {
          files: item.files.map(({ uploaded: _uploaded, ...file }) => file),
        }),
        ...(errorCode !== undefined && { errorCode }),
        ...(item.replyTo !== undefined && { replyTo: item.replyTo }),
      };
    });
    const value = { version: 1 as const, items };
    // Writes run one after another, so an older snapshot never lands after a newer one.
    this.saving = this.saving
      .then(() => (items.length ? store.save(value) : store.remove()))
      .catch(() => undefined);
    return this.saving;
  }

  private notify(): void {
    this.changed();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.store || !this.loaded || this.disposed) return;
    if (this.saveTimer !== undefined) this.timers.clearTimeout(this.saveTimer);
    this.saveTimer = this.timers.setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  private async hydrate(store: JsonStore): Promise<void> {
    let saved: z.infer<typeof storedOutbox> | undefined;
    try {
      const raw = await store.load();
      if (raw !== undefined) {
        const parsed = storedOutbox.safeParse(raw);
        if (parsed.success) saved = parsed.data;
        else await store.remove();
      }
    } catch {
      // An unreadable or unknown file is dropped, never a crash.
      await store.remove().catch(() => undefined);
    }
    if (this.disposed) return;
    let files: OutboxFiles | undefined;
    if (saved?.items.some((item) => item.voice || item.files?.length)) {
      try {
        files = await this.files();
      } catch {
        files = undefined;
      }
      if (this.disposed) return;
    }
    this.loaded = true;
    const resend: string[] = [];
    for (const item of saved?.items ?? []) {
      if (this.items.has(item.clientId)) continue;
      // A kept copy is found again after iOS moved the app's folder (an app update).
      const voiceUri = item.voice ? locateFile(files, item.voice.uri) : undefined;
      const voiceMissing = item.voice !== undefined && voiceUri === undefined;
      let filesMissing = false;
      const restoredFiles = item.files?.map((file) => {
        const located = locateFile(files, file.uri);
        // A file already uploaded sealed is only needed again for the person's own copy.
        const needed = file.sealedUpload === undefined || item.sealed === undefined;
        if (needed && located === undefined) filesMissing = true;
        return { ...file, uri: located ?? file.uri };
      });
      const missing = voiceMissing || filesMissing;
      // Its text was never saved, and the envelope was not: nothing can be sent (ADR-045).
      const unsent = item.privateChat === true && item.sealed === undefined;
      // A failure that will not clear by itself stays failed, with its reason; never resent.
      // A file reported missing that is found again now is sent again (a read can fail once).
      const keptFailure =
        item.state === 'failed' &&
        (item.errorCode === undefined ||
          (!TEMPORARY_FAILURES.includes(item.errorCode) &&
            item.errorCode !== FILE_MISSING &&
            item.errorCode !== VOICE_MISSING));
      // The saved clientId is resent as is, never a new one: the server dedupes on it.
      this.items.set(item.clientId, {
        clientId: item.clientId,
        agentId: item.agentId,
        text: item.text,
        ...((item.sealed !== undefined || unsent) && { privateChat: true as const }),
        ...(item.sealed !== undefined && { sealed: item.sealed }),
        createdAt: item.createdAt,
        ...(item.voice && { voice: { ...item.voice, uri: voiceUri ?? item.voice.uri } }),
        ...(restoredFiles && { files: restoredFiles }),
        ...(item.replyTo !== undefined && { replyTo: item.replyTo }),
        ...(unsent
          ? { state: 'failed' as const, errorCode: PRIVATE_UNSENT }
          : missing
            ? { state: 'failed' as const, errorCode: voiceMissing ? VOICE_MISSING : FILE_MISSING }
            : keptFailure
              ? {
                  state: 'failed' as const,
                  ...(item.errorCode !== undefined && { errorCode: item.errorCode }),
                }
              : { state: 'sending' as const }),
      });
      if (!missing && !unsent && !keptFailure) resend.push(item.clientId);
      if (item.sealed !== undefined) this.restoreText(item.clientId, item.agentId, item.sealed);
    }
    this.notify();
    for (const clientId of resend) void this.attempt(clientId);
  }

  /** A sealed queued message shows its text again, opened on this phone. */
  private restoreText(clientId: string, agentId: string, sealed: SealedEnvelopeV1): void {
    void this.sealer
      ?.openOwn(agentId, sealed)
      .then((text) => {
        const item = this.items.get(clientId);
        if (text === undefined || item === undefined || item.text !== '') return;
        this.items.set(clientId, { ...item, text });
        this.changed();
      })
      .catch(() => undefined);
  }

  /**
   * Seals a private chat's message before its first attempt. False when it must not go out:
   * the message is then failed in the outbox, never sent as text.
   */
  private async sealFirst(clientId: string): Promise<boolean> {
    const item = this.items.get(clientId);
    if (!item || item.sealed !== undefined || !this.sealer) return true;
    let isPrivate = item.privateChat === true;
    if (!isPrivate) {
      try {
        isPrivate = await this.sealer.isPrivate(item.agentId);
      } catch {
        isPrivate = false;
      }
    }
    if (!isPrivate) return true;
    // A voice note goes as it is: the server asks for the person's consent first.
    if (item.voice) return true;
    if (item.privateChat !== true) this.items.set(clientId, { ...item, privateChat: true });
    // Files are sealed and uploaded first, then the envelope names them (`sealPrivateFiles`).
    if (item.files?.length) {
      this.notify();
      return true;
    }
    try {
      const sealed = await this.sealer.seal(item.agentId, item.text, item.replyTo);
      const current = this.items.get(clientId);
      if (!current) return false;
      this.items.set(clientId, { ...current, privateChat: true, sealed });
      this.notify();
      return true;
    } catch (error) {
      return this.failPrivate(clientId, error);
    }
  }

  /** A private message that cannot go out is failed here, never sent as text. */
  private failPrivate(clientId: string, error: unknown): false {
    const code = (error as { code?: unknown } | undefined)?.code;
    const current = this.items.get(clientId);
    if (!current) return false;
    this.items.set(clientId, {
      ...current,
      privateChat: true,
      state: 'failed',
      errorCode: typeof code === 'string' ? code : 'seal_failed',
    });
    this.notify();
    return false;
  }

  /**
   * ADR-045, ruling 16: seal and upload each file, save its id and key, and only then seal the
   * envelope that names them. A file already uploaded (a retry) is not sent again. An ApiError
   * from the upload goes to the caller's retry; a failure that is not an ApiError propagates to
   * `attempt`'s catch, which fails the message there.
   */
  private async sealPrivateFiles(clientId: string, signal: AbortSignal): Promise<boolean> {
    const sealer = this.sealer;
    const item = this.items.get(clientId);
    if (!sealer || !item?.files) return false;
    for (const file of item.files) {
      if (file.sealedUpload !== undefined) continue;
      // Refused before sealing; a file of the wrong size never costs an upload.
      if (file.sizeBytes < 1) return this.failPrivate(clientId, { code: 'unsupported_file_type' });
      if (file.sizeBytes > MAX_FILE_BYTES)
        return this.failPrivate(clientId, { code: 'file_too_large' });
    }
    for (const file of item.files) {
      if (file.sealedUpload !== undefined) continue;
      let sealedFile = this.sealedBlobs.get(file.clientId);
      if (sealedFile === undefined) {
        try {
          sealedFile = await sealer.sealFile(item.agentId, file);
        } catch (error) {
          return this.failPrivate(clientId, error);
        }
        this.sealedBlobs.set(file.clientId, sealedFile);
      }
      const uploaded = await sealer.uploadSealed(
        item.agentId,
        { clientId: file.clientId, bytes: sealedFile.blob },
        signal,
      );
      this.sealedBlobs.delete(file.clientId);
      if (!this.items.has(clientId)) return false;
      file.sealedUpload = { id: uploaded.id, key: sealedFile.key };
      this.notify();
      // The person's own photo then shows from this copy, never from a download.
      await sealer.cacheOwnFile(uploaded.id, file.uri).catch(() => undefined);
    }
    if (item.sealed !== undefined) return true;
    try {
      const sealed = await sealer.seal(
        item.agentId,
        item.text,
        item.replyTo,
        item.files.map((file) => ({
          file_id: file.sealedUpload!.id,
          key: file.sealedUpload!.key,
          name: file.name,
          mime: file.mimeType,
          size: file.sizeBytes,
        })),
      );
      const current = this.items.get(clientId);
      if (!current) return false;
      this.items.set(clientId, { ...current, sealed });
      this.notify();
      return true;
    } catch (error) {
      return this.failPrivate(clientId, error);
    }
  }

  private start(clientId: string): void {
    this.notify();
    void this.keepFiles(clientId).then(() => this.attempt(clientId));
  }

  /** Copies a message's recording or files into its own folder before the first attempt. */
  private async keepFiles(clientId: string): Promise<void> {
    if (!this.store) return;
    const item = this.items.get(clientId);
    if (!item || (!item.voice && !item.files?.length)) return;
    let files: OutboxFiles;
    try {
      files = await this.files();
    } catch {
      return;
    }
    const keep = async (uri: string, key?: string) => {
      try {
        const kept = await files.keep(clientId, uri, key);
        if (kept !== uri) files.remove(uri);
        return kept;
      } catch {
        // Still sendable from the temporary file in this session.
        return uri;
      }
    };
    if (item.voice) item.voice = { ...item.voice, uri: await keep(item.voice.uri) };
    // Each file is named by its own clientId too: two picks can share a name.
    for (const file of item.files ?? []) file.uri = await keep(file.uri, file.clientId);
    if (this.items.get(clientId) !== item) {
      if (item.voice) this.removeFile(item.voice.uri);
      for (const file of item.files ?? []) this.removeFile(file.uri);
      return;
    }
    this.scheduleSave();
  }

  private removeFile(uri: string): void {
    void this.files()
      .then((files) => files.remove(locateFile(files, uri) ?? uri))
      .catch(() => undefined);
  }

  private stopWork(): void {
    this.disposed = true;
    if (this.saveTimer !== undefined) this.timers.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    for (const controller of this.controllers) controller.abort();
    for (const cancel of this.waits) cancel();
  }

  private wait(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (proceed: boolean) => {
        this.timers.clearTimeout(handle);
        this.waits.delete(cancel);
        resolve(proceed);
      };
      const cancel = () => finish(false);
      const handle = this.timers.setTimeout(() => finish(true), ms);
      this.waits.add(cancel);
    });
  }

  private async attempt(clientId: string): Promise<void> {
    if (!(await this.sealFirst(clientId))) return;
    const delays = [1_000, 3_000, 10_000];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const first = this.items.get(clientId);
      if (!first || this.disposed) return;
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        let item = first;
        if (item.privateChat === true && item.files?.length) {
          if (!(await this.sealPrivateFiles(clientId, controller.signal))) return;
          const sealed = this.items.get(clientId);
          if (!sealed) return;
          item = sealed;
        } else if (item.files?.length) {
          if (!this.upload) throw new Error('File upload unavailable');
          for (const file of item.files) {
            if (file.uploaded) continue;
            file.uploaded = await this.upload(item.agentId, file, controller.signal);
            this.notify();
          }
        }
        const message = await this.sendRequest(
          item.agentId,
          {
            clientId,
            text: item.text,
            ...(item.sealed !== undefined && { sealed: item.sealed }),
            ...(item.voice && { voice: item.voice }),
            ...(item.files?.length && {
              attachmentIds: item.files.map((file) => (file.sealedUpload ?? file.uploaded)!.id),
            }),
            ...(item.replyTo !== undefined && { replyTo: item.replyTo }),
          },
          controller.signal,
        );
        this.reconcile(message);
        return;
      } catch (error) {
        // The newest state: files may have been uploaded and an envelope sealed this attempt.
        const item = this.items.get(clientId);
        if (!item) return;
        if (
          error instanceof ApiError &&
          error.code === 'reply_to_not_found' &&
          item.replyTo !== undefined
        ) {
          // The quoted message was deleted meanwhile: send once more without the reply link,
          // under the same clientId. The server dedupes on client_id, so this can never post
          // the message twice; without replyTo this branch cannot run again.
          const unlinked = { ...item };
          delete unlinked.replyTo;
          this.items.set(clientId, unlinked);
          this.notify();
          attempt--;
          continue;
        }
        if (error instanceof ApiError && error.kind === 'file_missing') {
          this.items.set(clientId, {
            ...item,
            state: 'failed',
            error,
            errorCode: item.voice ? VOICE_MISSING : FILE_MISSING,
          });
          this.notify();
          return;
        }
        const retryable =
          error instanceof ApiError &&
          ![
            'file_too_large',
            'unsupported_file_type',
            'storage_full',
            'files_daily_limit',
          ].includes(error.code ?? '') &&
          (error.kind === 'network' ||
            error.kind === 'timeout' ||
            (error.kind === 'http' &&
              (error.status === 408 ||
                error.status === 429 ||
                (error.status !== undefined && error.status >= 500))));
        if (!retryable || attempt === delays.length) {
          // A private chat's refusal has its own plain copy, so it shows before any restart too.
          const privateRefusal = error instanceof ApiError && error.code === PRIVATE_THREAD;
          this.items.set(clientId, {
            ...item,
            state: 'failed',
            error,
            ...(privateRefusal && { errorCode: PRIVATE_THREAD }),
          });
          this.notify();
          return;
        }
        const delay =
          error instanceof ApiError && error.status === 429
            ? Math.max(0, error.resetsAt ? error.resetsAt.getTime() - this.timers.now() : 10_000)
            : delays[attempt];
        if (!(await this.wait(delay))) return;
      } finally {
        this.controllers.delete(controller);
      }
    }
  }
}
