import type { ThreadMessage } from '@twring/contracts';

/**
 * Chat search on the phone: a copy of chat text kept on this device so the person can search it.
 * The server never searches it. Only message text is kept, never files, tokens or keys. Every
 * write is best effort: a failure is logged with counts only and never reaches the chat.
 */
export interface SearchRow {
  id: string;
  agentId: string;
  role: 'you' | 'agent';
  text: string;
  createdAt: string;
  seq: number;
}

/** Where rows live: SQLite on the phone, an in-memory fake in tests. */
export interface SearchStore {
  upsert(rows: readonly SearchRow[]): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  removeAgent(agentId: string): Promise<void>;
  wipe(): Promise<void>;
  /** Rows holding every term (case-insensitive), newest first. */
  search(terms: readonly string[], limit: number): Promise<SearchRow[]>;
  isComplete(agentId: string): Promise<boolean>;
  setComplete(agentId: string): Promise<void>;
}

export interface SearchResult extends SearchRow {
  /** A short piece of the text around the first match. */
  snippet: string;
}

export type HistoryPage = (
  agentId: string,
  beforeSeq: number | undefined,
  signal: AbortSignal,
) => Promise<{ messages: readonly ThreadMessage[]; hasMore: boolean }>;

type Log = (event: string, counts: Record<string, number>) => void;
const defaultLog: Log = (event, counts) => {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn(`[chat search] ${event}`, counts);
};

/** The searchable text of a message, or undefined (calls, rings, notices, empty or bad text). */
export function searchRow(message: ThreadMessage): SearchRow | undefined {
  if (message.kind !== 'user_text' && message.kind !== 'agent_text') return undefined;
  const text: unknown = message.text;
  if (typeof text !== 'string' || !text.trim()) return undefined;
  if (typeof message.id !== 'string' || typeof message.agent_id !== 'string') return undefined;
  return {
    id: message.id,
    agentId: message.agent_id,
    role: message.kind === 'user_text' ? 'you' : 'agent',
    text,
    createdAt: typeof message.created_at === 'string' ? message.created_at : '',
    seq: typeof message.seq === 'number' ? message.seq : 0,
  };
}

/** The words of a query, lowercased; at most 8 so a pasted paragraph stays cheap. */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

const SNIPPET = 90;
/** 2,000 messages at 100 per page: the most the server keeps for one agent. */
const MAX_PAGES = 20;

/** About 90 characters of `text` around the first term, with dots where it was cut. */
export function snippet(text: string, terms: readonly string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SNIPPET) return flat;
  const lower = flat.toLowerCase();
  const at = terms.map((term) => lower.indexOf(term)).find((index) => index >= 0) ?? 0;
  const start = Math.max(0, Math.min(at - 30, flat.length - SNIPPET));
  const end = Math.min(flat.length, start + SNIPPET);
  return `${start > 0 ? '...' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '...' : ''}`;
}

export class SearchIndex {
  /** Chats tried this session: a failed fill is not retried until a reset. */
  private readonly tried = new Set<string>();

  constructor(
    private readonly store: SearchStore,
    private readonly log: Log = defaultLog,
  ) {}

  /** Keeps the text of messages the phone saw. Never throws, never blocks the caller. */
  record(messages: readonly ThreadMessage[]): Promise<void> {
    const rows = messages.flatMap((message) => searchRow(message) ?? []);
    if (!rows.length) return Promise.resolve();
    return this.safely('save failed', rows.length, () => this.store.upsert(rows));
  }
  forget(ids: readonly string[]): Promise<void> {
    if (!ids.length) return Promise.resolve();
    return this.safely('remove failed', ids.length, () => this.store.remove(ids));
  }
  forgetAgent(agentId: string): Promise<void> {
    this.tried.delete(agentId);
    return this.safely('remove chat failed', 1, () => this.store.removeAgent(agentId));
  }
  wipe(): Promise<void> {
    this.tried.clear();
    return this.safely('wipe failed', 1, () => this.store.wipe());
  }

  async search(query: string, limit = 100): Promise<SearchResult[]> {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    try {
      const rows = await this.store.search(terms, limit);
      return rows.map((row) => ({ ...row, snippet: snippet(row.text, terms) }));
    } catch {
      this.log('search failed', { terms: terms.length });
      return [];
    }
  }

  /**
   * Fills in older messages of chats not yet fully kept, one chat at a time, newest page first.
   * Each chat is tried at most once until a reset; a finished chat is remembered on the phone.
   * Stops quietly when `signal` aborts.
   */
  async fill(
    agentIds: readonly string[],
    page: HistoryPage,
    signal: AbortSignal,
    onProgress?: (busy: boolean) => void,
  ): Promise<void> {
    let busy = false;
    try {
      for (const agentId of agentIds) {
        if (signal.aborted) return;
        if (this.tried.has(agentId)) continue;
        this.tried.add(agentId);
        const complete = await this.store.isComplete(agentId).catch(() => false);
        if (complete || signal.aborted) continue;
        if (!busy) {
          busy = true;
          onProgress?.(true);
        }
        let before: number | undefined;
        let pages = 0;
        try {
          for (;;) {
            const result = await page(agentId, before, signal);
            if (signal.aborted) {
              // Cut short: this chat may be tried again next time.
              this.tried.delete(agentId);
              return;
            }
            pages++;
            await this.record(result.messages);
            const oldest = Math.min(...result.messages.map((message) => message.seq));
            // The server keeps at most 2,000 messages per agent: never page past that.
            if (
              !result.hasMore ||
              !result.messages.length ||
              !Number.isFinite(oldest) ||
              pages >= MAX_PAGES
            ) {
              await this.store.setComplete(agentId);
              break;
            }
            if (before !== undefined && oldest >= before) break;
            before = oldest;
          }
        } catch {
          if (signal.aborted) {
            this.tried.delete(agentId);
            return;
          }
          this.log('fill failed', { pages });
        }
      }
    } finally {
      if (busy) onProgress?.(false);
    }
  }

  private async safely(event: string, count: number, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch {
      this.log(event, { count });
    }
  }
}

/** For tests and for a session with no signed-in account: nothing outlives the process. */
export function memorySearchStore(): SearchStore & { rows: Map<string, SearchRow> } {
  const rows = new Map<string, SearchRow>();
  const complete = new Set<string>();
  return {
    rows,
    upsert: (incoming) => {
      for (const row of incoming) rows.set(row.id, row);
      return Promise.resolve();
    },
    remove: (ids) => {
      for (const id of ids) rows.delete(id);
      return Promise.resolve();
    },
    removeAgent: (agentId) => {
      for (const [id, row] of rows) if (row.agentId === agentId) rows.delete(id);
      complete.delete(agentId);
      return Promise.resolve();
    },
    wipe: () => {
      rows.clear();
      complete.clear();
      return Promise.resolve();
    },
    search: (terms, limit) =>
      Promise.resolve(
        [...rows.values()]
          .filter((row) => terms.every((term) => row.text.toLowerCase().includes(term)))
          .sort(newestFirst)
          .slice(0, limit),
      ),
    isComplete: (agentId) => Promise.resolve(complete.has(agentId)),
    setComplete: (agentId) => {
      complete.add(agentId);
      return Promise.resolve();
    },
  };
}

export function newestFirst(a: SearchRow, b: SearchRow): number {
  return b.createdAt.localeCompare(a.createdAt) || b.seq - a.seq;
}
