import type { Attachment, ThreadMessage } from '@twring/contracts';
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
  voice?: { uri: string; durationMs: number };
  files?: PreparedFile[];
  error?: unknown;
  /** A stable machine code for a failure with no error object (a file lost over a restart). */
  errorCode?: string;
}

/** At most this many queued messages are saved for the next launch, newest kept. */
export const OUTBOX_LIMIT = 50;
const SAVE_DEBOUNCE_MS = 300;
/** A queued voice note or file was no longer on the phone after a restart. */
export const FILE_MISSING = 'file_missing';

const storedUri = z.string().min(1).max(2_000);
const storedOutbox = z.object({
  version: z.literal(1),
  items: z
    .array(
      z.object({
        clientId: z.string().min(1).max(100),
        agentId: z.string().min(1).max(100),
        text: z.string().max(20_000),
        state: z.enum(['sending', 'failed']),
        createdAt: z.string().max(100),
        voice: z.object({ uri: storedUri, durationMs: z.number().nonnegative() }).optional(),
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
            }),
          )
          .max(20)
          .optional(),
        errorCode: z.string().max(100).optional(),
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
        voice?: { uri: string; durationMs: number };
        attachmentIds?: string[];
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

  send(agentId: string, text: string): string {
    const clientId = newClientId();
    this.items.set(clientId, {
      clientId,
      agentId,
      text,
      state: 'sending',
      createdAt: new Date().toISOString(),
    });
    this.notify();
    void this.attempt(clientId);
    return clientId;
  }

  sendFiles(agentId: string, text: string, files: PreparedFile[]): string {
    const clientId = newClientId();
    this.items.set(clientId, {
      clientId,
      agentId,
      text,
      files: files.map((file) => ({ ...file })),
      state: 'sending',
      createdAt: new Date().toISOString(),
    });
    this.start(clientId);
    return clientId;
  }

  sendVoice(agentId: string, uri: string, durationMs: number): string {
    const clientId = newClientId();
    this.items.set(clientId, {
      clientId,
      agentId,
      text: `Voice note · ${callDuration(Math.round(durationMs / 1000))} · Sending…`,
      state: 'sending',
      createdAt: new Date().toISOString(),
      voice: { uri, durationMs },
    });
    this.start(clientId);
    return clientId;
  }

  retry(clientId: string): void {
    const item = this.items.get(clientId);
    if (!item || item.state !== 'failed') return;
    this.items.set(clientId, { ...item, state: 'sending', error: undefined, errorCode: undefined });
    this.notify();
    void this.attempt(clientId);
  }

  reconcile(message: ThreadMessage): void {
    if (message.kind !== 'user_text') return;
    const item = this.items.get(message.client_id);
    if (item?.agentId === message.agent_id) {
      this.items.delete(message.client_id);
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
    this.changed();
    const store = this.store;
    if (store) await this.saving.then(() => store.remove()).catch(() => undefined);
  }

  /**
   * Stops sending but keeps the saved queue and its files for the next launch on this account
   * (switching servers). Resolves once the latest queue is written.
   */
  async detach(): Promise<void> {
    await this.flush();
    this.stopWork();
    this.items.clear();
    this.changed();
  }

  /** Writes the queue now, replacing a pending debounced write. */
  flush(): Promise<void> {
    if (this.saveTimer !== undefined) this.timers.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const store = this.store;
    if (!store || !this.loaded || this.disposed) return this.saving;
    const items = [...this.items.values()].slice(-OUTBOX_LIMIT).map((item) => {
      const errorCode = item.errorCode ?? errorCodeOf(item.error);
      return {
        clientId: item.clientId,
        agentId: item.agentId,
        text: item.text,
        state: item.state,
        createdAt: item.createdAt,
        ...(item.voice && { voice: item.voice }),
        // An upload is redone after a restart under the same file clientId.
        ...(item.files?.length && {
          files: item.files.map(({ uploaded: _uploaded, ...file }) => file),
        }),
        ...(errorCode !== undefined && { errorCode }),
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
      const uris = [
        ...(item.voice ? [item.voice.uri] : []),
        ...(item.files ?? []).map((file) => file.uri),
      ];
      const missing = uris.some((uri) => !(files?.exists(uri) ?? false));
      // The saved clientId is resent as is, never a new one: the server dedupes on it.
      this.items.set(item.clientId, {
        clientId: item.clientId,
        agentId: item.agentId,
        text: item.text,
        createdAt: item.createdAt,
        ...(item.voice && { voice: item.voice }),
        ...(item.files && { files: item.files.map((file) => ({ ...file })) }),
        ...(missing
          ? { state: 'failed' as const, errorCode: FILE_MISSING }
          : { state: 'sending' as const }),
      });
      if (!missing) resend.push(item.clientId);
    }
    this.notify();
    for (const clientId of resend) void this.attempt(clientId);
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
    const keep = async (uri: string) => {
      try {
        const kept = await files.keep(clientId, uri);
        if (kept !== uri) files.remove(uri);
        return kept;
      } catch {
        // Still sendable from the temporary file in this session.
        return uri;
      }
    };
    if (item.voice) item.voice = { ...item.voice, uri: await keep(item.voice.uri) };
    for (const file of item.files ?? []) file.uri = await keep(file.uri);
    if (this.items.get(clientId) !== item) {
      if (item.voice) this.removeFile(item.voice.uri);
      for (const file of item.files ?? []) this.removeFile(file.uri);
      return;
    }
    this.scheduleSave();
  }

  private removeFile(uri: string): void {
    void this.files()
      .then((files) => files.remove(uri))
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
    const delays = [1_000, 3_000, 10_000];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const item = this.items.get(clientId);
      if (!item || this.disposed) return;
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        if (item.files?.length) {
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
            ...(item.voice && { voice: item.voice }),
            ...(item.files?.length && {
              attachmentIds: item.files.map((file) => file.uploaded!.id),
            }),
          },
          controller.signal,
        );
        this.reconcile(message);
        return;
      } catch (error) {
        if (!this.items.has(clientId)) return;
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
          this.items.set(clientId, { ...item, state: 'failed', error });
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
