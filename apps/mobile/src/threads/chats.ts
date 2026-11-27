import {
  threadSummarySchema,
  type ThreadMessage,
  type ThreadSocketFrame,
  type ThreadSummary,
} from '@twring/contracts';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';

import { twringApi, ApiError, type TwringApi } from '@/api';
import { addBeforeSignOut, apiAuth, authController, authHeaders } from '@/auth';
import { mobileEnv } from '@/config/env';
import { activeServerUrl, onActiveServerChanged } from '../servers/active';
import { profileStore } from '../servers/profiles';
import { STATUS_POLL_MS } from '@/hooks/useResource';
import { ringPlatform } from '../platform/ring';

import type { OpenedMessage } from '../e2e/sealed-thread';
import {
  forgetListPreview,
  loadListPreviews,
  previewText,
  saveListPreview,
  type ListPreview,
} from '../e2e/list-previews';
import { forgetPrivateDevice, PrivateChats } from '../e2e/private-chats';
import { phoneQuote } from '../e2e/private-quote';
import { undeliveredIds } from '../e2e/private-state';
import { noKeychain, scopedKeychain } from '../e2e/scoped-keychain';
import type { SecureKeyValue } from '../auth/storage';
import {
  applyFrame,
  emptyChat,
  openLatest,
  replaceLatest,
  upsert,
  type ChatState,
} from './chat-store';
import { DraftStore } from './drafts';
import {
  Outbox,
  systemTimers,
  type OutboxSealer,
  type OutboxTimers,
  type PendingMessage,
} from './outbox';
import { fileStore, memoryStore, storageScope, type JsonStore } from './outbox-storage';
import type { PreparedFile } from './files';
import {
  clearSealedFiles,
  deviceSealedFiles,
  openSealedFile,
  type SealedFileRef,
  type SealedFiles,
  sweepShareCopiesOnce,
} from './sealed-file-cache';
import { SearchIndex, memorySearchStore, type SearchRow } from './search-index';
import { deleteSearchDatabase, sqliteSearchStore } from './search-store';
import { connectThreadSocket } from './socket';

/** After a 404 (chats off), the list is asked again after 20 s, doubling up to 5 min. */
const OFF_RETRY_MIN_MS = 20_000;
const OFF_RETRY_MAX_MS = 5 * 60_000;
/** How long the server's echo of this phone's own Clear chat is recognised as that echo. */
const OWN_CLEAR_ECHO_MS = 60_000;

export class ChatController {
  private revision = 0;
  private epoch = 0;
  private readonly chats = new Map<string, ChatState>();
  private readonly listeners = new Set<() => void>();
  private readonly outbox: Outbox;
  private readonly drafts: DraftStore;
  private readonly reads = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly catching = new Map<string, Promise<void>>();
  private readonly reloading = new Map<string, Promise<void>>();
  private socketConnectedBefore = false;
  private readonly focusCounts = new Map<string, number>();
  private summaries: ThreadSummary[] = [];
  private availability: boolean | undefined;
  /** While chats are off (404): when the list may be asked again, and the wait after that. */
  private offRetryAt = 0;
  private offBackoffMs = OFF_RETRY_MIN_MS;
  private readonly timers: OutboxTimers;
  /** The chat list arrived since the last clear: each chat's privacy is known. */
  private listLoaded = false;
  /** The saved list from last time is on screen until the server's arrives. */
  private hydrated = false;
  /** The last list load failed: the screen shows what it has instead of waiting. */
  private listFailed = false;
  private readonly summaryStore?: JsonStore;
  /** The private keychain holding the Chats list's opened previews (`e2e/list-previews`). */
  private readonly previewStore?: SecureKeyValue;
  /** Opened previews of private chats' last messages, by chat; the saved ones load first. */
  private readonly previews = new Map<string, ListPreview>();
  /** When this phone last cleared each chat, so the server's echo of it keeps newer typing. */
  private readonly clearedHere = new Map<string, number>();
  private readonly previewing = new Set<string>();
  /** Bumped when opened previews are dropped, so an open still running cannot put one back. */
  private previewGeneration = 0;
  private filesAvailable = false;
  private socket?: ReturnType<typeof connectThreadSocket>;
  private appSubscription?: { remove(): void };
  private stopNetInfo?: () => void;
  private listPromise?: Promise<void>;
  private readonly search: SearchIndex;
  /** Aborted on clear(): a fill in progress stops when the person signs out or switches. */
  private filling = new AbortController();
  private readonly privacy?: PrivateChats;
  private shareHistory?: (privateAgentIds: string[]) => void;
  private readonly sealedFiles: SealedFiles;
  /** Opened private messages per chat, in memory only, for the messages list they came from. */
  private readonly opened = new Map<
    string,
    { from: ChatState['messages']; list: OpenedMessage[] }
  >();

  constructor(
    private readonly api: TwringApi,
    private readonly socketOptions?: { url: string; requireSecureMedia: boolean },
    stores: {
      outbox?: JsonStore;
      drafts?: JsonStore;
      search?: SearchIndex;
      privacy?: PrivateChats;
      /** Runs re-wrap jobs for these private chats (C3 #11 Task 28); once per controller. */
      shareHistory?: (privateAgentIds: string[]) => void;
      /** Reads and copies local files for sealing; the device's own when none. */
      sealedFiles?: SealedFiles;
      /** The last chat list, shown on the next start until the server answers. */
      summaries?: JsonStore;
      /** The private keychain for the Chats list's short opened previews. */
      previews?: SecureKeyValue;
    } = {},
    timers: OutboxTimers = systemTimers,
  ) {
    this.timers = timers;
    this.privacy = stores.privacy;
    this.privacy?.onRemoved(() => void this.dropOpenedPrivate());
    this.shareHistory = stores.shareHistory;
    this.sealedFiles = stores.sealedFiles ?? deviceSealedFiles;
    this.summaryStore = stores.summaries;
    this.previewStore = stores.previews;
    this.hydrate();
    this.outbox = new Outbox(
      async (agentId, message, signal) => {
        if (message.sealed !== undefined && !this.api.sendSealedMessage)
          throw new Error('Private chats unavailable');
        const sent = message.sealed
          ? await this.api.sendSealedMessage!(
              agentId,
              {
                clientId: message.clientId,
                sealed: message.sealed,
                ...(message.attachmentIds?.length && { attachmentIds: message.attachmentIds }),
                ...(message.replyTo !== undefined && { replyTo: message.replyTo }),
              },
              signal,
            ).catch((error: unknown) => {
              // A failed private send: was this phone removed by another one meanwhile?
              this.checkPrivateRemoved(agentId);
              throw error;
            })
          : message.voice
            ? await this.api.sendVoiceNote(
                agentId,
                message.clientId,
                message.voice.durationMs,
                message.voice.uri,
                signal,
                message.replyTo,
                message.voice.serverReadable,
              )
            : await this.api.sendMessage(agentId, message, signal);
        // Shown at once from the reply; the socket and catch-up only refresh it.
        this.put(agentId, upsert(this.getChat(agentId), [sent]));
        return sent;
      },
      () => this.emit(),
      timers,
      (agentId, file, signal) => {
        if (!this.api.uploadFile) return Promise.reject(new Error('File upload unavailable'));
        return this.api.uploadFile(
          agentId,
          { clientId: file.clientId, uri: file.uri, name: file.name, mimeType: file.mimeType },
          signal,
        );
      },
      stores.outbox && { store: stores.outbox },
      this.sealer(),
    );
    this.search = stores.search ?? new SearchIndex(memorySearchStore());
    // Until the chat list loads, no chat is known to be ordinary: its draft is not written yet.
    // A failed first load leaves chats usable but the list unknown, so it does not count.
    this.drafts = new DraftStore(stores.drafts ?? memoryStore(), timers, (agentId) =>
      this.listLoaded ? this.isPrivate(agentId) : undefined,
    );
  }

  /** The saved list and previews from last time, before the server answers. */
  private hydrate(): void {
    const epoch = this.epoch;
    void this.summaryStore
      ?.load()
      .then((saved) => {
        if (epoch !== this.epoch || this.listLoaded || saved === undefined) return;
        const parsed = threadSummarySchema.array().safeParse(saved);
        if (!parsed.success) {
          void this.summaryStore?.remove().catch(() => undefined);
          return;
        }
        this.summaries = parsed.data;
        this.hydrated = true;
        this.emit();
      })
      .catch(() => undefined);
    if (this.privacy && this.previewStore)
      void loadListPreviews(this.previewStore).then((saved) => {
        if (epoch !== this.epoch) return;
        for (const [agentId, preview] of saved)
          if (!this.previews.has(agentId)) this.previews.set(agentId, preview);
        if (saved.size > 0) this.emit();
      });
  }

  /**
   * The opened text of a private chat's last message for the Chats list, or undefined (the list
   * then says "Private message"). Opening runs in the background and saves a short preview.
   */
  getPreview = (agentId: string): string | undefined => {
    const last = this.summaries.find((summary) => summary.agent_id === agentId)?.last_message;
    if (last?.kind !== 'sealed') return undefined;
    const known = this.previews.get(agentId);
    if (known?.messageId === last.id) return known.text;
    if (this.privacy && !this.previewing.has(last.id)) {
      const privacy = this.privacy;
      const epoch = this.epoch;
      const generation = this.previewGeneration;
      this.previewing.add(last.id);
      void privacy
        .openPreview(agentId, last)
        .then((text) => {
          if (epoch !== this.epoch || generation !== this.previewGeneration) return;
          if (text === undefined || !text.trim()) return;
          const preview = { messageId: last.id, text: previewText(text) };
          this.previews.set(agentId, preview);
          if (this.previewStore)
            void saveListPreview(this.previewStore, agentId, preview).catch(() => undefined);
          this.emit();
        })
        .finally(() => this.previewing.delete(last.id));
    }
    return undefined;
  };

  /** Private chats never go out as text, even with no way to seal on this phone. */
  private sealer(): OutboxSealer {
    return {
      known: (agentId) => this.isPrivate(agentId),
      isPrivate: async (agentId) => {
        if (this.availability === undefined) await this.refreshList();
        return this.isPrivate(agentId);
      },
      seal: (agentId, text, replyTo, files) => {
        if (!this.privacy)
          return Promise.reject(Object.assign(new Error(), { code: 'seal_failed' }));
        // The quote is built here from the opened text; the server never sees it (Task 22).
        const target =
          replyTo === undefined
            ? undefined
            : this.getOpened(agentId)?.find((message) => message.id === replyTo);
        return this.privacy.seal(agentId, text, phoneQuote(target), files).catch((error) => {
          this.checkPrivateRemoved(agentId);
          throw error;
        });
      },
      sealFile: async (agentId, file) => {
        if (!this.privacy) throw Object.assign(new Error(), { code: 'seal_failed' });
        let bytes: Uint8Array;
        try {
          bytes = await this.sealedFiles.read(file.uri);
        } catch {
          throw Object.assign(new Error(), { code: 'file_missing' });
        }
        return this.privacy.sealFileBytes(agentId, bytes);
      },
      uploadSealed: async (agentId, file, signal) => {
        if (!this.api.uploadSealedFile) throw new Error('Private chats unavailable');
        return this.api.uploadSealedFile(agentId, file, signal);
      },
      cacheOwnFile: (fileId, localUri) => this.sealedFiles.cacheOwn(fileId, localUri),
      openOwn: (agentId, sealed) =>
        this.privacy?.openOwn(agentId, sealed) ?? Promise.resolve(undefined),
    };
  }

  /** A private chat (ADR-044), as the server's chat list says. */
  isPrivate(agentId: string): boolean {
    return this.summaries.some(
      (summary) => summary.agent_id === agentId && summary.private === true,
    );
  }

  /** The server says this chat holds messages it can read, loaded on this phone or not. */
  hasReadableMessages(agentId: string): boolean {
    return this.summaries.some(
      (summary) => summary.agent_id === agentId && summary.readable_messages === true,
    );
  }

  /** A private chat's messages as opened on this phone; undefined while the keys load. */
  getOpened = (agentId: string): OpenedMessage[] | undefined => {
    if (!this.privacy || !this.isPrivate(agentId)) return undefined;
    const messages = this.getChat(agentId).messages;
    const cached = this.opened.get(agentId);
    if (cached?.from === messages) return cached.list;
    const list = this.privacy.open(agentId, messages);
    if (list === undefined) {
      void this.privacy.context(agentId).then((ctx) => {
        if (ctx !== undefined) this.emit();
      });
      return undefined;
    }
    this.opened.set(agentId, { from: messages, list });
    // An unchanged message keeps its opened entry: only new or changed ones go to search again.
    const before = new Set(cached?.list);
    this.keepOpenedSearchable(
      agentId,
      messages,
      list.filter((entry) => !before.has(entry)),
    );
    return list;
  };

  /** Opened text goes to the phone's search; a message that could not be opened never does. */
  private keepOpenedSearchable(
    agentId: string,
    messages: readonly ThreadMessage[],
    list: readonly OpenedMessage[],
  ): void {
    const byId = new Map(messages.map((message) => [message.id, message]));
    const rows: SearchRow[] = [];
    for (const message of list) {
      if (message.state !== 'ok' || message.partial || !message.text.trim()) continue;
      const source = byId.get(message.id);
      rows.push({
        id: message.id,
        agentId,
        role: message.author === 'user' ? 'you' : 'agent',
        text: message.text,
        createdAt: source?.created_at ?? '',
        seq: source?.seq ?? 0,
      });
    }
    void this.search.recordPrivate(rows);
  }

  /** A private chat's whole history opened on this phone for "Export chat" (Task 23). */
  openForExport(
    agentId: string,
    messages: readonly ThreadMessage[],
  ): Promise<OpenedMessage[] | undefined> {
    return this.privacy?.openForExport(agentId, messages) ?? Promise.resolve(undefined);
  }

  /** Opens one photo or file of a private chat (ADR-045); never throws. */
  async openSealedFile(
    agentId: string,
    file: SealedFileRef,
  ): Promise<{ uri: string } | { error: 'couldnt_open' }> {
    const ctx = await this.privacy?.context(agentId);
    if (ctx === undefined) return { error: 'couldnt_open' };
    return openSealedFile(agentId, file, { accountId: ctx.accountId, agentId: ctx.agentId });
  }

  /** A private chat with no computer to send to: "Pair your computer again" (P3b ruling 3). */
  getPairAgain = (agentId: string): boolean =>
    this.privacy !== undefined &&
    this.isPrivate(agentId) &&
    this.privacy.ready(agentId) !== undefined
      ? this.privacy.pairAgain(agentId)
      : false;

  /** What a private chat says about its keys (pair again, set up again, lost keys), if anything. */
  getPrivateNotice = (agentId: string): string | undefined =>
    this.privacy !== undefined && this.isPrivate(agentId)
      ? this.privacy.notice(agentId)
      : undefined;

  /** Another phone removed this one from private chats; true until Set up. */
  getPrivateRemoved = (agentId: string): boolean =>
    this.privacy !== undefined && this.isPrivate(agentId) && this.privacy.removed();

  /** This phone's unanswered private messages once it was removed: shown as not delivered. */
  getUndelivered = (agentId: string): ReadonlySet<string> =>
    this.getPrivateRemoved(agentId)
      ? undeliveredIds(
          this.getChat(agentId).messages,
          (m) => this.privacy!.sealedToRemoved(m),
          this.privacy!.removedSince(),
        )
      : NONE_UNDELIVERED;

  /** Reads the device list again (throttled) to learn whether this phone was removed. */
  checkPrivateRemoved(agentId: string): void {
    if (this.privacy !== undefined && this.isPrivate(agentId))
      void this.privacy.checkRemoved(agentId);
  }

  private dropPreviews(): void {
    this.previews.clear();
    this.previewGeneration++;
    this.previewing.clear();
  }

  /** After a restore, pairing or approval: private chats load the key and computers again. */
  resetPrivate(): void {
    this.opened.clear();
    this.dropPreviews();
    this.privacy?.reset();
    this.emit();
  }

  /** Removing this phone on the devices screen: its private chat keys go (the sign-out path). */
  async forgetPrivateKeys(): Promise<void> {
    await Promise.all([this.privacy?.forget(), this.dropOpenedPrivate()]);
  }

  /**
   * The one wipe of what this phone opened (R3-3, R3-4), for Remove this phone and for a phone
   * another phone removed: opened text in memory and in search, and opened files on disk.
   */
  private async dropOpenedPrivate(): Promise<void> {
    this.opened.clear();
    this.dropPreviews();
    this.search.forgetPrivate();
    await clearSealedFiles();
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getAvailability = (): boolean | undefined => this.availability;
  getFilesAvailable = (): boolean => this.filesAvailable;
  getRevision = (): number => this.revision;
  getSummaries = (): ThreadSummary[] => this.summaries;
  /** The list on screen is worth showing: loaded, saved from last time, off, or failed to load. */
  isListReady = (): boolean =>
    this.listLoaded || this.hydrated || this.listFailed || this.availability === false;

  /** Private chats' agent ids once the list has loaded; undefined before (not an empty list). */
  loadedPrivateAgentIds = (): string[] | undefined =>
    this.listLoaded
      ? this.summaries.filter((t) => t.private === true).map((t) => t.agent_id)
      : undefined;
  getChat = (agentId: string): ChatState => this.chats.get(agentId) ?? EMPTY_CHAT;
  getPending = (agentId: string): PendingMessage[] => this.outbox.list(agentId);
  private emit(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  private put(agentId: string, state: ChatState): void {
    this.keepSearchable(this.chats.get(agentId), state);
    this.chats.set(agentId, state);
    this.emit();
    this.scheduleRead(agentId);
  }

  /** Copies new or changed text to the phone's search, and drops messages that were deleted. */
  private keepSearchable(before: ChatState | undefined, after: ChatState): void {
    if (before?.messages === after.messages) return;
    const old = new Map(before?.messages.map((message) => [message.id, message]));
    const changed = after.messages.filter((message) => old.get(message.id) !== message);
    for (const message of after.messages) old.delete(message.id);
    void this.search.record(changed);
    void this.search.forget([...old.keys()]);
  }

  /** Words to find in chats kept on this phone, newest first. */
  searchChats(query: string) {
    return this.search.search(query);
  }

  /** Fills in older messages of every chat for search; see SearchIndex.fill. */
  fillSearch(signal: AbortSignal, onProgress?: (busy: boolean) => void): Promise<void> {
    // Either the screen closing or a sign-out stops it (AbortSignal.any is not on every engine).
    const both = new AbortController();
    for (const source of [signal, this.filling.signal]) {
      if (source.aborted) both.abort();
      else source.addEventListener('abort', () => both.abort(), { once: true });
    }
    const stop = both.signal;
    return this.search.fill(
      this.summaries.map((summary) => summary.agent_id),
      (agentId, beforeSeq, pageSignal) =>
        this.api.listMessages(
          agentId,
          { ...(beforeSeq !== undefined && { beforeSeq }), limit: 100 },
          pageSignal,
        ),
      stop,
      onProgress,
    );
  }

  /** After an agent is deleted: its chat text leaves the phone too. */
  forgetAgent(agentId: string): Promise<void> {
    this.chats.delete(agentId);
    this.opened.delete(agentId);
    return this.search.forgetAgent(agentId);
  }

  /** After "Delete my data": nothing of the chats stays on the phone. */
  forgetSearch(): Promise<void> {
    // Private chats hand search only what is new, so a wiped search starts again from scratch.
    this.opened.clear();
    return this.search.wipe();
  }

  private ensureSocket(): void {
    if (this.socket || !this.socketOptions || this.availability === false) return;
    this.socket = connectThreadSocket({
      ...this.socketOptions,
      headers: authHeaders,
      refreshAuth: () => apiAuth()?.refresh() ?? Promise.resolve(undefined),
      onFrame: (frame) => this.frame(frame),
      onState: (state) => {
        if (state !== 'connected') return;
        for (const agentId of this.focusCounts.keys()) void this.catchUp(agentId);
        // The first connection follows open(), which just loaded the newest page.
        if (this.socketConnectedBefore) this.reloadFocused();
        this.socketConnectedBefore = true;
      },
    });
    this.appSubscription = AppState.addEventListener('change', (state) => {
      // A chat left open behind the home screen is not being read: let the server notify again.
      if (state !== 'active') {
        this.socket?.setFocus(null);
        // iOS may suspend the app next: a pending save (a Delete) is written now.
        void this.outbox.flush();
        return;
      }
      // Back in the app: a phone removed meanwhile learns it before sending.
      for (const agentId of this.focusCounts.keys()) this.checkPrivateRemoved(agentId);
      // A socket the server refused for good stays one handle: reopen that same one.
      if (this.socket?.stopped()) this.socket.reconnect();
      // One waiting out a backoff after a lost network tries again now.
      else this.socket?.retryNow();
      this.socket?.setFocus([...this.focusCounts.keys()].at(-1) ?? null);
      for (const agentId of this.focusCounts.keys()) void this.catchUp(agentId);
      this.reloadFocused();
    });
    this.stopNetInfo?.();
    const epoch = this.epoch;
    // NetInfo reports the current network first: that one only sets what a change is measured from.
    let last: { connected: boolean; network: string } | undefined;
    // The last network seen connected, kept across offline spells.
    let lastConnected: string | undefined;
    this.stopNetInfo = NetInfo.addEventListener((net) => {
      if (epoch !== this.epoch) return;
      const connected = net.isConnected === true;
      const details: unknown = net.details;
      const ip =
        typeof details === 'object' && details !== null && 'ipAddress' in details
          ? String(details.ipAddress)
          : '';
      const network = `${net.type}|${ip}`;
      const before = last;
      const lastNetwork = lastConnected;
      last = { connected, network };
      if (connected) lastConnected = network;
      if (!before || !connected) return;
      // A new network (also one that returns after offline): the open socket may sit on the old one.
      if (lastNetwork !== undefined && lastNetwork !== network) {
        this.socket?.retryNow({ networkChanged: true });
      } else if (!before.connected) {
        // Back online on the same network: skip the backoff wait.
        this.socket?.retryNow();
      }
    });
  }

  async refreshList(): Promise<void> {
    if (this.listPromise) return this.listPromise;
    // Chats off is asked again with a growing wait, so it comes back without a restart.
    if (this.availability === false && this.timers.now() < this.offRetryAt) return;
    const epoch = this.epoch;
    this.listPromise = this.api
      .listThreads()
      .then(({ threads, files }) => {
        if (epoch !== this.epoch) return;
        this.summaries = threads;
        this.filesAvailable = files;
        this.availability = true;
        this.offBackoffMs = OFF_RETRY_MIN_MS;
        this.listLoaded = true;
        this.listFailed = false;
        // Plain summaries only: a private chat's last message is still sealed here.
        void this.summaryStore?.save(threads).catch(() => undefined);
        this.drafts.privacyChanged();
        // Older private messages for a phone approved here: once, when the app opens.
        const share = this.shareHistory;
        this.shareHistory = undefined;
        share?.(threads.filter((t) => t.private === true).map((t) => t.agent_id));
        this.emit();
        this.ensureSocket();
      })
      .catch((error: unknown) => {
        if (epoch !== this.epoch) return;
        if (error instanceof ApiError && error.kind === 'http' && error.status === 404) {
          this.availability = false;
          this.offRetryAt = this.timers.now() + this.offBackoffMs;
          this.offBackoffMs = Math.min(this.offBackoffMs * 2, OFF_RETRY_MAX_MS);
          this.socket?.close();
          this.socket = undefined;
          // ensureSocket adds these again when chats come back.
          this.appSubscription?.remove();
          this.appSubscription = undefined;
          this.stopNetInfo?.();
          this.stopNetInfo = undefined;
          this.emit();
          return;
        }
        // A transient failure does not mean the server disabled chats.
        if (!this.listFailed) {
          this.listFailed = true;
          this.emit();
        }
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
    // Focus first, so the server stops pushing this chat while its messages load.
    this.ensureSocket();
    this.socket?.setFocus(agentId);
    await this.refreshList();
    if (epoch !== this.epoch || this.availability === false || !this.focusCounts.has(agentId))
      return;
    // The chat opened again: a phone removed meanwhile learns it before sending.
    this.checkPrivateRemoved(agentId);
    try {
      const knownSeq = this.getChat(agentId).messages.at(-1)?.seq ?? 0;
      const page = await this.api.listMessages(agentId, { limit: 50 });
      if (epoch !== this.epoch || !this.focusCounts.has(agentId)) return;
      // Cached messages the page no longer holds were deleted or cleared while this chat was shut.
      this.put(agentId, {
        ...openLatest(replaceLatest(this.getChat(agentId), page, knownSeq), page),
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

  send(agentId: string, text: string, replyTo?: string): string {
    return this.outbox.send(agentId, text, replyTo);
  }
  sendFiles(agentId: string, text: string, files: PreparedFile[], replyTo?: string): string {
    return this.outbox.sendFiles(agentId, text, files, replyTo);
  }
  sendVoice(
    agentId: string,
    uri: string,
    durationMs: number,
    replyTo?: string,
    options?: { serverReadable?: boolean },
  ): string {
    return this.outbox.sendVoice(agentId, uri, durationMs, replyTo, options);
  }
  /** Deletes a message everywhere; throws the server's refusal (409 while it is answered). */
  async deleteMessage(agentId: string, messageId: string): Promise<void> {
    if (!this.api.deleteMessage) throw new Error('Deleting messages is unavailable');
    const epoch = this.epoch;
    await this.api.deleteMessage(agentId, messageId);
    if (epoch !== this.epoch) return;
    this.put(
      agentId,
      applyFrame(this.getChat(agentId), agentId, {
        type: 'message.deleted',
        agent_id: agentId,
        message_id: messageId,
      }),
    );
  }

  /**
   * Reloads the newest page so messages deleted while the socket was down disappear: a delete
   * does not bump rev, so catch-up cannot report it. Overlapping calls share one request.
   */
  reloadLatest(agentId: string): Promise<void> {
    if (this.availability === false) return Promise.resolve();
    const existing = this.reloading.get(agentId);
    if (existing) return existing;
    const epoch = this.epoch;
    const knownSeq = this.getChat(agentId).messages.at(-1)?.seq ?? 0;
    const work = this.api
      .listMessages(agentId, { limit: 50 })
      .then((page) => {
        if (epoch !== this.epoch) return;
        this.put(agentId, replaceLatest(this.getChat(agentId), page, knownSeq));
        for (const message of page.messages) this.outbox.reconcile(message);
      })
      .catch(() => undefined)
      .finally(() => {
        this.reloading.delete(agentId);
      });
    this.reloading.set(agentId, work);
    return work;
  }
  private reloadFocused(): void {
    for (const agentId of this.focusCounts.keys()) void this.reloadLatest(agentId);
  }
  discard(clientId: string): void {
    this.outbox.discard(clientId);
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

  /** Answers a private chat's sealed approval (C3 #11) with a sealed, signed decision. */
  async decideSealedApproval(
    agentId: string,
    messageId: string,
    approvalId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    if (!this.privacy) throw new Error('Private chats unavailable');
    const epoch = this.epoch;
    const sealed = await this.privacy.sealDecision(agentId, approvalId, decision);
    try {
      const message = await this.api.decideSealedApproval(agentId, messageId, sealed);
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
    if (frame.type === 'thread.cleared') {
      void this.search.forgetAgent(agentId);
      // Cleared elsewhere: the same as Clear chat here, so no old send, draft or preview remains.
      // The echo of this phone's own clear is skipped: what was typed since then is new.
      const clearedHere = this.clearedHere.get(agentId);
      this.clearedHere.delete(agentId);
      if (clearedHere === undefined || Date.now() - clearedHere > OWN_CLEAR_ECHO_MS)
        this.dropChatData(agentId);
    }
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

  /** Signing out forgets the saved queue and drafts; switching servers keeps them for later. */
  async clear(options: { forget?: boolean } = {}): Promise<void> {
    this.epoch++;
    // No chat of the old account or server stays on screen for notifications.
    ringPlatform.setVisibleChat(null);
    this.filling.abort();
    this.filling = new AbortController();
    this.socket?.close();
    this.socket = undefined;
    this.socketConnectedBefore = false;
    this.appSubscription?.remove();
    this.appSubscription = undefined;
    this.stopNetInfo?.();
    this.stopNetInfo = undefined;
    for (const timer of this.reads.values()) clearTimeout(timer);
    this.reads.clear();
    this.focusCounts.clear();
    this.chats.clear();
    this.opened.clear();
    this.previews.clear();
    this.previewing.clear();
    // Opened files are plaintext on disk: they go on any clear, as the opened text does.
    const privacy = Promise.all([
      options.forget ? this.privacy?.forget() : undefined,
      clearSealedFiles(),
    ]);
    const outbox = options.forget ? this.outbox.clear() : this.outbox.detach();
    // Opened private text in memory goes on any clear: a switch must not show it to another account.
    this.search.forgetPrivate();
    const search = options.forget ? this.search.wipe() : Promise.resolve();
    const drafts = options.forget ? this.drafts.clear() : this.drafts.flush();
    const summaries = options.forget ? this.summaryStore?.remove() : undefined;
    this.summaries = [];
    this.listLoaded = false;
    this.hydrated = false;
    this.listFailed = false;
    this.availability = undefined;
    this.offRetryAt = 0;
    this.offBackoffMs = OFF_RETRY_MIN_MS;
    this.filesAvailable = false;
    this.emit();
    await Promise.all([outbox, drafts, search, privacy, summaries?.catch(() => undefined)]);
  }

  getDraft(agentId: string): Promise<string> {
    return this.drafts.get(agentId);
  }
  setDraft(agentId: string, text: string): void {
    this.drafts.set(agentId, text);
  }
  /** After "Clear chat": unsent messages are dropped and the composer starts empty too. */
  forgetChat(agentId: string): void {
    this.clearedHere.set(agentId, Date.now());
    this.dropChatData(agentId);
  }
  /** Unsent messages, draft and list preview of one chat: gone after a clear, here or elsewhere. */
  private dropChatData(agentId: string): void {
    void clearSealedFiles();
    void this.outbox.forgetAgent(agentId);
    this.drafts.forget(agentId);
    this.previews.delete(agentId);
    this.previewGeneration++;
    this.previewing.clear();
    if (this.previewStore)
      void forgetListPreview(this.previewStore, agentId).catch(() => undefined);
  }
  /** Leaving a chat writes its draft now instead of after the debounce. */
  flushDrafts(): void {
    void this.drafts.flush();
  }
}

/** The signed-in account on the active server, or undefined (nothing is then saved). */
export function currentScope(): string | undefined {
  const active = profileStore.active();
  if (active.kind === 'selfhost')
    return storageScope(
      { kind: 'selfhost', serverId: active.serverId, personId: active.person.id },
      undefined,
    );
  const state = authController()?.getState();
  return storageScope({ kind: 'hosted' }, state?.status === 'signed_in' ? state.userId : undefined);
}

/** The keychain for private chat keys (`deviceOnlyStore`), loaded only when first used. */
const deviceKeychain = () => import('../platform/secure-store').then((m) => m.deviceOnlyStore);
const keychain: SecureKeyValue = {
  getItemAsync: (key) => deviceKeychain().then((store) => store.getItemAsync(key)),
  setItemAsync: (key, value) => deviceKeychain().then((store) => store.setItemAsync(key, value)),
  deleteItemAsync: (key) => deviceKeychain().then((store) => store.deleteItemAsync(key)),
};

/** This server and account's private chat keys (P3c ruling 1); nothing is kept when signed out. */
export function privateKeychain(scope = currentScope()): SecureKeyValue {
  return scope === undefined ? noKeychain : scopedKeychain(keychain, scope);
}

let controller: ChatController | undefined;
let controllerScope: string | undefined;
let signOutHookRegistered = false;
export function chatController(): ChatController | undefined {
  const api = twringApi();
  if (!api || !mobileEnv.ok) return undefined;
  const scope = currentScope();
  if (controller && controllerScope !== scope) {
    // The account changed under a running controller: start again with this account's state.
    void controller.clear();
    controller = undefined;
  }
  if (!controller) {
    // App start: remove opened copies and chat exports a killed share sheet left behind.
    void sweepShareCopiesOnce();
    controllerScope = scope;
    controller = new ChatController(
      api,
      {
        url: activeServerUrl(),
        requireSecureMedia: mobileEnv.env.CORD_ENV !== 'development',
      },
      scope
        ? {
            outbox: fileStore('outbox', scope),
            drafts: fileStore('drafts', scope),
            summaries: fileStore('summaries', scope),
            previews: privateKeychain(scope),
            search: new SearchIndex(sqliteSearchStore(scope)),
            privacy: new PrivateChats({
              store: privateKeychain(scope),
              replay: fileStore('private', scope),
              ...(api.privateDevices !== undefined && {
                devices: () => api.privateDevices!(),
              }),
              // Loaded when first used, like the keychain: the server calls need the app's auth.
              rewraps: {
                read: (agentId, deviceId, after) =>
                  import('../e2e/pair-api').then((m) =>
                    m.rewrapApi().read(agentId, deviceId, after),
                  ),
              },
              addressOf: (agentId) =>
                api.getAgent(agentId).then(
                  (found) => found.endpoint_url,
                  () => undefined,
                ),
            }),
            shareHistory: (agentIds) => {
              void import('../e2e/share-history')
                .then((m) => m.shareHistory(api, privateKeychain(scope), agentIds))
                .catch(() => undefined);
            },
          }
        : {},
    );
    if (!signOutHookRegistered) {
      addBeforeSignOut(async () => {
        const signingOut = currentScope();
        const ending = controller;
        controller = undefined;
        if (ending) await ending.clear({ forget: true });
        // State saved by an earlier launch that never opened chats this time.
        if (signingOut)
          await Promise.all([
            fileStore('outbox', signingOut).remove(),
            fileStore('drafts', signingOut).remove(),
            fileStore('private', signingOut).remove(),
            fileStore('agents', signingOut).remove(),
            fileStore('summaries', signingOut).remove(),
            deleteSearchDatabase(signingOut),
            clearSealedFiles(),
            forgetPrivateDevice(privateKeychain(signingOut)),
          ]).catch(() => undefined);
      });
      signOutHookRegistered = true;
    }
  }
  return controller;
}

// Chats belong to one server: a switch drops them (kept on disk for that account), and the next
// chatController() starts fresh.
onActiveServerChanged(() => {
  void controller?.clear();
  controller = undefined;
});

/** The composer's text for one chat: restored when the chat opens, saved as it changes. */
export function useDraft(agentId: string): [string, (text: string) => void] {
  'use no memo';
  const active = chatController();
  const [draft, setLocal] = useState('');
  useEffect(() => {
    let current = true;
    void active?.getDraft(agentId).then((saved) => {
      // Text typed while the file was read is kept.
      if (current && saved) setLocal((typed) => typed || saved);
    });
    return () => {
      current = false;
      active?.flushDrafts();
    };
  }, [active, agentId]);
  const setDraft = useCallback(
    (text: string) => {
      setLocal(text);
      active?.setDraft(agentId, text);
    },
    [active, agentId],
  );
  return [draft, setDraft];
}

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
    send: (text: string, replyTo?: string) => active?.send(agentId, text, replyTo),
    sendFiles: (text: string, files: PreparedFile[], replyTo?: string) =>
      active?.sendFiles(agentId, text, files, replyTo),
    sendVoice: (
      uri: string,
      durationMs: number,
      replyTo?: string,
      options?: { serverReadable?: boolean },
    ) => active?.sendVoice(agentId, uri, durationMs, replyTo, options),
    deleteMessage: (messageId: string) =>
      active ? active.deleteMessage(agentId, messageId) : Promise.resolve(),
    retry: (clientId: string) => active?.retry(clientId),
    discard: (clientId: string) => active?.discard(clientId),
    stop: (messageId: string) => active?.stop(agentId, messageId),
    decideApproval: (messageId: string, decision: 'approve' | 'deny') =>
      active?.decideApproval(agentId, messageId, decision),
    decideSealedApproval: (messageId: string, approvalId: string, decision: 'approve' | 'deny') =>
      active?.decideSealedApproval(agentId, messageId, approvalId, decision),
    loadOlder: () => active?.loadOlder(agentId),
    /** Private chats: the opened messages (memory only) and whether to pair again. */
    private: active?.isPrivate(agentId) ?? false,
    readableMessages: active?.hasReadableMessages(agentId) ?? false,
    opened: active?.getOpened(agentId),
    pairAgain: active?.getPairAgain(agentId) ?? false,
    privateNotice: active?.getPrivateNotice(agentId),
    /** Another phone removed this one: its unanswered messages were not delivered. */
    privateRemoved: active?.getPrivateRemoved(agentId) ?? false,
    undelivered: active?.getUndelivered(agentId) ?? NONE_UNDELIVERED,
    available: active?.getAvailability() ?? false,
    filesAvailable: active?.getFilesAvailable() ?? false,
  };
}

const EMPTY_CHAT = emptyChat();
const NONE_UNDELIVERED: ReadonlySet<string> = new Set();
const EMPTY_LIST: ThreadSummary[] = [];
const noopSubscribe = () => () => undefined;
const zero = () => 0;
export function useChatList(): {
  threads: ThreadSummary[];
  available: boolean;
  /** The server said chats are off (404), as opposed to not known yet. */
  off: boolean;
  /** Rows can be drawn: until then the list would show the wrong order and lines. */
  ready: boolean;
  /** A private chat's opened last-message preview, when this phone has one. */
  preview(agentId: string): string | undefined;
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
    ready: active?.isListReady() ?? true,
    preview: (agentId) => active?.getPreview(agentId),
    refresh: () => {
      void active?.refreshList();
    },
  };
}

/** Forgets this phone's private chat keys (removing this phone on the devices screen). */
export async function forgetThisPhonePrivateKeys(): Promise<void> {
  const active = chatController();
  if (active !== undefined) await active.forgetPrivateKeys();
  else await forgetPrivateDevice(privateKeychain());
  await clearSealedFiles();
}

/** A restore, pairing or approval changed this phone's key or computers: chats read them again. */
export function resetPrivateChats(): void {
  chatController()?.resetPrivate();
}
