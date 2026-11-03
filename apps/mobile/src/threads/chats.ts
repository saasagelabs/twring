import type { ThreadSocketFrame, ThreadSummary } from '@twring/contracts';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { twringApi, ApiError, type TwringApi } from '@/api';
import { addBeforeSignOut, authHeaders } from '@/auth';
import { mobileEnv } from '@/config/env';
import { activeServerUrl, onActiveServerChanged } from '../servers/active';
import { STATUS_POLL_MS } from '@/hooks/useResource';

import { applyFrame, emptyChat, upsert, type ChatState } from './chat-store';
import { Outbox, type PendingMessage } from './outbox';
import type { PreparedFile } from './files';
import { connectThreadSocket } from './socket';

export class ChatController {
  private revision = 0;
  private epoch = 0;
  private readonly chats = new Map<string, ChatState>();
  private readonly listeners = new Set<() => void>();
  private readonly outbox: Outbox;
  private readonly reads = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly catching = new Map<string, Promise<void>>();
  private readonly focusCounts = new Map<string, number>();
  private summaries: ThreadSummary[] = [];
  private availability: boolean | undefined;
  private filesAvailable = false;
  private socket?: ReturnType<typeof connectThreadSocket>;
  private appSubscription?: { remove(): void };
  private listPromise?: Promise<void>;

  constructor(
    private readonly api: TwringApi,
    private readonly socketOptions?: { url: string; requireSecureMedia: boolean },
  ) {
    this.outbox = new Outbox(
      async (agentId, message, signal) => {
        const sent = message.voice
          ? await this.api.sendVoiceNote(
              agentId,
              message.clientId,
              message.voice.durationMs,
              message.voice.uri,
              signal,
            )
          : await this.api.sendMessage(agentId, message, signal);
        // Shown at once from the reply; the socket and catch-up only refresh it.
        this.put(agentId, upsert(this.getChat(agentId), [sent]));
        return sent;
      },
      () => this.emit(),
      undefined,
      (agentId, file, signal) => {
        if (!this.api.uploadFile) return Promise.reject(new Error('File upload unavailable'));
        return this.api.uploadFile(
          agentId,
          { clientId: file.clientId, uri: file.uri, name: file.name, mimeType: file.mimeType },
          signal,
        );
      },
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getAvailability = (): boolean | undefined => this.availability;
  getFilesAvailable = (): boolean => this.filesAvailable;
  getRevision = (): number => this.revision;
  getSummaries = (): ThreadSummary[] => this.summaries;
  getChat = (agentId: string): ChatState => this.chats.get(agentId) ?? EMPTY_CHAT;
  getPending = (agentId: string): PendingMessage[] => this.outbox.list(agentId);
  private emit(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  private put(agentId: string, state: ChatState): void {
    this.chats.set(agentId, state);
    this.emit();
    this.scheduleRead(agentId);
  }

  private ensureSocket(): void {
    if (this.socket || !this.socketOptions || this.availability === false) return;
    this.socket = connectThreadSocket({
      ...this.socketOptions,
      headers: authHeaders,
      onFrame: (frame) => this.frame(frame),
      onState: (state) => {
        if (state === 'connected')
          for (const agentId of this.focusCounts.keys()) void this.catchUp(agentId);
      },
    });
    this.appSubscription = AppState.addEventListener('change', (state) => {
      // A chat left open behind the home screen is not being read: let the server notify again.
      if (state !== 'active') {
        this.socket?.setFocus(null);
        return;
      }
      this.socket?.setFocus([...this.focusCounts.keys()].at(-1) ?? null);
      for (const agentId of this.focusCounts.keys()) void this.catchUp(agentId);
    });
  }

  async refreshList(): Promise<void> {
    if (this.availability === false) return;
    if (this.listPromise) return this.listPromise;
    const epoch = this.epoch;
    this.listPromise = this.api
      .listThreads()
      .then(({ threads, files }) => {
        if (epoch !== this.epoch) return;
        this.summaries = threads;
        this.filesAvailable = files;
        this.availability = true;
        this.emit();
        this.ensureSocket();
      })
      .catch((error: unknown) => {
        if (epoch !== this.epoch) return;
        if (error instanceof ApiError && error.kind === 'http' && error.status === 404) {
          this.availability = false;
          this.socket?.close();
          this.socket = undefined;
          this.emit();
          return;
        }
        // A transient failure does not mean the server disabled chats.
        if (this.availability === undefined) {
          this.availability = true;
          this.emit();
          this.ensureSocket();
        }
      })
      .finally(() => {
        this.listPromise = undefined;
      });
    return this.listPromise;
  }

  async open(agentId: string): Promise<void> {
    const epoch = this.epoch;
    this.focusCounts.set(agentId, (this.focusCounts.get(agentId) ?? 0) + 1);
    await this.refreshList();
    if (epoch !== this.epoch || this.availability === false || !this.focusCounts.has(agentId))
      return;
    try {
      const page = await this.api.listMessages(agentId, { limit: 50 });
      if (epoch !== this.epoch || !this.focusCounts.has(agentId)) return;
      this.put(agentId, {
        ...upsert(this.getChat(agentId), page.messages),
        hasOlder: page.hasMore,
      });
      for (const message of page.messages) this.outbox.reconcile(message);
    } catch {
      /* The socket or next foreground catch-up can recover this page. */
    }
    this.ensureSocket();
    this.socket?.setFocus(agentId);
    void this.catchUp(agentId);
  }

  closeChat(agentId: string): void {
    const count = (this.focusCounts.get(agentId) ?? 0) - 1;
    if (count > 0) this.focusCounts.set(agentId, count);
    else this.focusCounts.delete(agentId);
    this.socket?.setFocus([...this.focusCounts.keys()].at(-1) ?? null);
    const timer = this.reads.get(agentId);
    if (timer) clearTimeout(timer);
    this.reads.delete(agentId);
  }

  async catchUp(agentId: string): Promise<void> {
    if (this.availability === false) return;
    const epoch = this.epoch;
    const existing = this.catching.get(agentId);
    if (existing) return existing;
    const work = (async () => {
      let cursor = this.getChat(agentId).maxRev;
      for (;;) {
        const page = await this.api.listMessages(agentId, { afterRev: cursor, limit: 100 });
        if (epoch !== this.epoch) break;
        if (!page.messages.length) break;
        this.put(agentId, upsert(this.getChat(agentId), page.messages));
        for (const message of page.messages) this.outbox.reconcile(message);
        const next = Math.max(cursor, ...page.messages.map((message) => message.rev));
        if (!page.hasMore || next === cursor) break;
        cursor = next;
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.catching.delete(agentId);
      });
    this.catching.set(agentId, work);
    return work;
  }

  async loadOlder(agentId: string): Promise<void> {
    const epoch = this.epoch;
    const state = this.getChat(agentId);
    if (!state.hasOlder || !state.messages.length) return;
    const page = await this.api.listMessages(agentId, {
      beforeSeq: state.messages[0].seq,
      limit: 50,
    });
    if (epoch !== this.epoch) return;
    this.put(agentId, { ...upsert(this.getChat(agentId), page.messages), hasOlder: page.hasMore });
  }

  send(agentId: string, text: string): string {
    return this.outbox.send(agentId, text);
  }
  sendFiles(agentId: string, text: string, files: PreparedFile[]): string {
    return this.outbox.sendFiles(agentId, text, files);
  }
  sendVoice(agentId: string, uri: string, durationMs: number): string {
    return this.outbox.sendVoice(agentId, uri, durationMs);
  }
  retry(clientId: string): void {
    this.outbox.retry(clientId);
  }
  async stop(agentId: string, messageId: string): Promise<void> {
    const epoch = this.epoch;
    const message = await this.api.stopMessage(agentId, messageId);
    if (epoch !== this.epoch) return;
    this.put(agentId, upsert(this.getChat(agentId), [message]));
  }

  async decideApproval(
    agentId: string,
    messageId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    const epoch = this.epoch;
    try {
      const message = await this.api.decideChatApproval(agentId, messageId, decision);
      if (epoch === this.epoch) this.put(agentId, upsert(this.getChat(agentId), [message]));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.currentMessage) {
        if (epoch === this.epoch)
          this.put(agentId, upsert(this.getChat(agentId), [error.currentMessage]));
        return;
      }
      throw error;
    }
  }

  frame(frame: ThreadSocketFrame): void {
    const agentId = frame.type === 'message.upserted' ? frame.message.agent_id : frame.agent_id;
    if (frame.type === 'message.upserted') this.outbox.reconcile(frame.message);
    this.put(agentId, applyFrame(this.getChat(agentId), agentId, frame));
    // Progress arrives every 250 ms while a reply streams; only real changes refresh the list.
    if (frame.type !== 'turn.progress') void this.refreshList();
  }

  private scheduleRead(agentId: string): void {
    if (!this.focusCounts.has(agentId)) return;
    const highest = this.getChat(agentId).messages.at(-1)?.seq;
    if (highest === undefined) return;
    const prior = this.reads.get(agentId);
    if (prior) clearTimeout(prior);
    this.reads.set(
      agentId,
      setTimeout(() => {
        this.reads.delete(agentId);
        if (this.focusCounts.has(agentId))
          void this.api.markRead(agentId, highest).catch(() => undefined);
      }, 1_000),
    );
  }

  clear(): void {
    this.epoch++;
    this.socket?.close();
    this.socket = undefined;
    this.appSubscription?.remove();
    this.appSubscription = undefined;
    for (const timer of this.reads.values()) clearTimeout(timer);
    this.reads.clear();
    this.focusCounts.clear();
    this.chats.clear();
    this.outbox.clear();
    this.summaries = [];
    this.availability = undefined;
    this.filesAvailable = false;
    this.emit();
  }
}

let controller: ChatController | undefined;
let signOutHookRegistered = false;
export function chatController(): ChatController | undefined {
  const api = twringApi();
  if (!api || !mobileEnv.ok) return undefined;
  if (!controller) {
    controller = new ChatController(api, {
      url: activeServerUrl(),
      requireSecureMedia: mobileEnv.env.CORD_ENV !== 'development',
    });
    if (!signOutHookRegistered) {
      addBeforeSignOut(() => {
        controller?.clear();
        controller = undefined;
        return Promise.resolve();
      });
      signOutHookRegistered = true;
    }
  }
  return controller;
}

// Chats belong to one server: a switch drops them, and the next chatController() starts fresh.
onActiveServerChanged(() => {
  controller?.clear();
  controller = undefined;
});

export function useChat(agentId: string) {
  // Reads a mutable controller after subscribing: the React Compiler must not cache those reads.
  'use no memo';
  const active = chatController();
  useEffect(() => {
    if (!active) return;
    void active.open(agentId);
    return () => active.closeChat(agentId);
  }, [active, agentId]);
  // Snapshots must retain identity until the store changes.
  useSyncExternalStore(active?.subscribe ?? noopSubscribe, active?.getRevision ?? zero);
  return {
    state: active?.getChat(agentId) ?? EMPTY_CHAT,
    pending: active?.getPending(agentId) ?? [],
    send: (text: string) => active?.send(agentId, text),
    sendFiles: (text: string, files: PreparedFile[]) => active?.sendFiles(agentId, text, files),
    sendVoice: (uri: string, durationMs: number) => active?.sendVoice(agentId, uri, durationMs),
    retry: (clientId: string) => active?.retry(clientId),
    stop: (messageId: string) => active?.stop(agentId, messageId),
    decideApproval: (messageId: string, decision: 'approve' | 'deny') =>
      active?.decideApproval(agentId, messageId, decision),
    loadOlder: () => active?.loadOlder(agentId),
    available: active?.getAvailability() ?? false,
    filesAvailable: active?.getFilesAvailable() ?? false,
  };
}

const EMPTY_CHAT = emptyChat();
const EMPTY_LIST: ThreadSummary[] = [];
const noopSubscribe = () => () => undefined;
const zero = () => 0;
export function useChatList(): {
  threads: ThreadSummary[];
  available: boolean;
  /** The server said chats are off (404), as opposed to not known yet. */
  off: boolean;
  refresh(): void;
} {
  // Reads a mutable controller after subscribing: the React Compiler must not cache those reads.
  'use no memo';
  const active = chatController();
  useFocusEffect(
    useCallback(() => {
      if (!active) return;
      void active.refreshList();
      const timer = setInterval(() => {
        void active.refreshList();
      }, STATUS_POLL_MS);
      return () => clearInterval(timer);
    }, [active]),
  );
  useSyncExternalStore(active?.subscribe ?? noopSubscribe, active?.getRevision ?? zero);
  const threads = active?.getSummaries() ?? EMPTY_LIST;
  return {
    threads,
    available: active?.getAvailability() ?? false,
    off: active?.getAvailability() === false,
    refresh: () => {
      void active?.refreshList();
    },
  };
}
