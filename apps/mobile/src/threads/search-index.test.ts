import type { ThreadMessage } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  memorySearchStore,
  SearchIndex,
  searchRow,
  snippet,
  type HistoryPage,
  type SearchStore,
} from './search-index';

const agent = 'agt_abcdefghij0123456789';
const other = 'agt_zyxwvutsrq9876543210';
const text = (seq: number, body: string, agentId = agent, kind = 'user_text'): ThreadMessage =>
  ({
    id: `msg_${agentId.slice(4, 8)}${String(seq).padStart(16, '0')}`,
    agent_id: agentId,
    seq,
    rev: seq,
    kind,
    text: body,
    ...(kind === 'user_text'
      ? { status: 'answered', client_id: '123e4567-e89b-42d3-a456-426614174000' }
      : { cut: false, partial: false }),
    created_at: `2026-11-${String(10 + seq).padStart(2, '0')}T00:00:00.000Z`,
    updated_at: '2026-11-24T00:00:00.000Z',
  }) as ThreadMessage;

describe('searchRow', () => {
  it('keeps only text messages with text', () => {
    expect(searchRow(text(1, 'hello'))?.role).toBe('you');
    expect(searchRow(text(2, 'reply', agent, 'agent_text'))?.role).toBe('agent');
    expect(searchRow(text(3, '   '))).toBeUndefined();
    expect(searchRow({ ...text(4, 'x'), text: undefined } as unknown as ThreadMessage)).toBe(
      undefined,
    );
    expect(searchRow({ ...text(5, 'x'), kind: 'notice' } as unknown as ThreadMessage)).toBe(
      undefined,
    );
  });
});

describe('snippet', () => {
  it('shows short text whole and cuts long text around the match', () => {
    expect(snippet('short  text', ['text'])).toBe('short text');
    const long = `${'a '.repeat(80)}needle ${'b '.repeat(80)}`;
    const cut = snippet(long, ['needle']);
    expect(cut).toContain('needle');
    expect(cut.startsWith('...')).toBe(true);
    expect(cut.endsWith('...')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(96);
  });
});

describe('SearchIndex', () => {
  it('finds every word, newest first, with a snippet', async () => {
    const index = new SearchIndex(memorySearchStore());
    await index.record([
      text(1, 'Buy green apples'),
      text(3, 'The apples are green', other, 'agent_text'),
      text(2, 'Red apples only'),
    ]);
    const found = await index.search('  GREEN apples ');
    expect(found.map((row) => row.seq)).toEqual([3, 1]);
    expect(found[0]).toMatchObject({ agentId: other, role: 'agent' });
    expect(found[0].snippet).toBe('The apples are green');
    expect(await index.search('   ')).toEqual([]);
    expect(await index.search('banana')).toEqual([]);
  });

  it('forgets messages, a chat and everything', async () => {
    const store = memorySearchStore();
    const index = new SearchIndex(store);
    await index.record([text(1, 'one'), text(2, 'two'), text(3, 'three', other)]);
    await index.forget([text(1, 'one').id]);
    expect(store.rows.size).toBe(2);
    await index.forgetAgent(agent);
    expect([...store.rows.values()].map((row) => row.agentId)).toEqual([other]);
    await index.wipe();
    expect(store.rows.size).toBe(0);
  });

  it('a failing store never throws and logs counts only', async () => {
    const fail = () => Promise.reject(new Error('disk full'));
    const store: SearchStore = {
      upsert: fail,
      remove: fail,
      removeAgent: fail,
      wipe: fail,
      search: fail,
      isComplete: fail,
      setComplete: fail,
    };
    const log = vi.fn();
    const index = new SearchIndex(store, log);
    await expect(index.record([text(1, 'secret words')])).resolves.toBeUndefined();
    await expect(index.forget(['x'])).resolves.toBeUndefined();
    await expect(index.wipe()).resolves.toBeUndefined();
    await expect(index.search('secret')).resolves.toEqual([]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });
});

describe('filling older messages', () => {
  const pages =
    (byAgent: Record<string, ThreadMessage[]>, size = 2): HistoryPage =>
    (agentId, before) => {
      const all = byAgent[agentId] ?? [];
      const older = all.filter((message) => before === undefined || message.seq < before);
      const pageMessages = older.slice(-size);
      return Promise.resolve({ messages: pageMessages, hasMore: older.length > size });
    };

  it('pages each chat until done and does not fetch a finished chat again', async () => {
    const store = memorySearchStore();
    const index = new SearchIndex(store);
    const history = {
      [agent]: [1, 2, 3, 4, 5].map((seq) => text(seq, `note ${seq}`)),
      [other]: [text(1, 'hi', other)],
    };
    const page = vi.fn(pages(history));
    const progress = vi.fn();
    await index.fill([agent, other], page, new AbortController().signal, progress);
    expect(page.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [agent, undefined],
      [agent, 4],
      [agent, 2],
      [other, undefined],
    ]);
    expect(store.rows.size).toBe(6);
    expect(progress.mock.calls).toEqual([[true], [false]]);
    expect(await store.isComplete(agent)).toBe(true);

    await index.fill([agent, other], page, new AbortController().signal);
    expect(page).toHaveBeenCalledTimes(4);
    // A new session (after a restart) still remembers the finished chats.
    await new SearchIndex(store).fill([agent, other], page, new AbortController().signal);
    expect(page).toHaveBeenCalledTimes(4);
  });

  it('stops when the screen closes and tries that chat again next time', async () => {
    const store = memorySearchStore();
    const index = new SearchIndex(store);
    const abort = new AbortController();
    const history = { [agent]: [1, 2, 3, 4, 5].map((seq) => text(seq, `n ${seq}`)) };
    const page = vi.fn<HistoryPage>((agentId, before, signal) => {
      abort.abort();
      return pages(history)(agentId, before, signal);
    });
    await index.fill([agent, other], page, abort.signal);
    expect(page).toHaveBeenCalledTimes(1);
    expect(await store.isComplete(agent)).toBe(false);
    await index.fill([agent], pages(history), new AbortController().signal);
    expect(await store.isComplete(agent)).toBe(true);
  });

  it('a failed chat is not retried until a reset', async () => {
    const index = new SearchIndex(memorySearchStore(), () => undefined);
    const page = vi.fn<HistoryPage>().mockRejectedValue(new Error('offline'));
    await index.fill([agent], page, new AbortController().signal);
    await index.fill([agent], page, new AbortController().signal);
    expect(page).toHaveBeenCalledTimes(1);
    await index.wipe();
    await index.fill([agent], page, new AbortController().signal);
    expect(page).toHaveBeenCalledTimes(2);
  });
});
