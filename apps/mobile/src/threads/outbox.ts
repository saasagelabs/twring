import type { Attachment, ThreadMessage } from '@twring/contracts';

import { ApiError } from '../api/client';
import { callDuration } from './presentation';
import type { PreparedFile } from './files';

export interface PendingMessage {
  clientId: string;
  agentId: string;
  text: string;
  state: 'sending' | 'failed';
  createdAt: string;
  voice?: { uri: string; durationMs: number };
  files?: PreparedFile[];
  error?: unknown;
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

const systemTimers: OutboxTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class Outbox {
  private readonly items = new Map<string, PendingMessage>();
  private readonly waits = new Set<() => void>();
  private readonly controllers = new Set<AbortController>();
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
  ) {}

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
    this.changed();
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
    this.changed();
    void this.attempt(clientId);
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
    this.changed();
    void this.attempt(clientId);
    return clientId;
  }

  retry(clientId: string): void {
    const item = this.items.get(clientId);
    if (!item || item.state !== 'failed') return;
    this.items.set(clientId, { ...item, state: 'sending', error: undefined });
    this.changed();
    void this.attempt(clientId);
  }

  reconcile(message: ThreadMessage): void {
    if (message.kind !== 'user_text') return;
    const item = this.items.get(message.client_id);
    if (item?.agentId === message.agent_id) {
      this.items.delete(message.client_id);
      if (item.voice) this.removeFile(item.voice.uri);
      for (const file of item.files ?? []) this.removeFile(file.uri);
      this.changed();
    }
  }

  clear(): void {
    for (const controller of this.controllers) controller.abort();
    for (const cancel of this.waits) cancel();
    for (const item of this.items.values()) {
      if (item.voice) this.removeFile(item.voice.uri);
      for (const file of item.files ?? []) this.removeFile(file.uri);
    }
    this.items.clear();
    this.changed();
  }

  private removeFile(uri: string): void {
    void import('expo-file-system')
      .then(({ File }) => {
        try {
          new File(uri).delete();
        } catch {
          /* A temporary recording may already be gone. */
        }
      })
      .catch(() => undefined);
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
      if (!item) return;
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        if (item.files?.length) {
          if (!this.upload) throw new Error('File upload unavailable');
          for (const file of item.files) {
            if (file.uploaded) continue;
            file.uploaded = await this.upload(item.agentId, file, controller.signal);
            this.changed();
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
          this.changed();
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
