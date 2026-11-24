import type { ThreadMessage } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  collectThread,
  escapeInline,
  exportFileName,
  renderChatMarkdown,
  type ExportPageSource,
} from './export-markdown';

const AGENT = 'agt_aaaaaaaaaaaaaaaaaaaa';
const time = (seq: number) => `2026-11-24T10:${String(seq % 60).padStart(2, '0')}:00.000Z`;
const base = (seq: number) => ({
  id: `msg_${String(seq).padStart(20, 'a').replace(/[0-9]/g, 'b')}${seq}`,
  agent_id: AGENT,
  seq,
  rev: seq,
  created_at: time(seq),
  updated_at: time(seq),
});

function user(seq: number, text: string, extra: object = {}): ThreadMessage {
  return {
    ...base(seq),
    kind: 'user_text',
    text,
    status: 'answered',
    client_id: '00000000-0000-4000-8000-000000000000',
    ...extra,
  };
}
function agent(seq: number, text: string, extra: object = {}): ThreadMessage {
  return {
    ...base(seq),
    kind: 'agent_text',
    text,
    cut: false,
    partial: false,
    ...extra,
  };
}

const opts = {
  agentName: 'Hermes',
  exportedAt: new Date(2026, 10, 24),
  formatTime: (iso: string) => iso.slice(11, 16),
};

describe('renderChatMarkdown', () => {
  it('formats each message kind', () => {
    const file = {
      id: 'fil_x',
      name: 'notes.pdf',
      mime_type: 'application/pdf',
      size_bytes: 10,
    };
    const md = renderChatMarkdown(
      [
        user(1, 'hello'),
        agent(2, 'hi there', { attachments: [file] }),
        user(3, 'remind me', { voice: { duration_s: 4 } }),
        { ...base(4), kind: 'call', call_id: 'c', duration_s: 180, outcome: 'completed' },
        { ...base(5), kind: 'notice', code: 'new_session' },
      ] as ThreadMessage[],
      opts,
    );
    expect(md).toContain('# Chat with Hermes');
    expect(md).toContain('Exported 2026-11-24');
    expect(md).toContain('**You** (10:01):\n\n> hello');
    expect(md).toContain('**Hermes** (10:02):\n\n> hi there\n\n_Files: notes.pdf_');
    expect(md).toContain('> Voice note (transcript): remind me');
    expect(md).toContain('_Call, 3 min, completed_');
    expect(md).toContain('_New conversation started_');
  });

  it('keeps Markdown inside a message from breaking the structure', () => {
    const md = renderChatMarkdown([agent(1, '# Title\n```\ncode\n\n**You** (fake):')], {
      ...opts,
      agentName: 'Bad *name* #1',
    });
    expect(md).toContain('# Chat with Bad \\*name\\* \\#1');
    for (const line of md.split('\n').slice(md.split('\n').indexOf('> # Title'))) {
      if (line) expect(line.startsWith('>')).toBe(true);
    }
    expect(md.match(/^\*\*You\*\*/gm)).toBeNull();
    expect(escapeInline('a\nb_[c]')).toBe('a b\\_\\[c\\]');
  });

  it('says so when the chat is empty', () => {
    expect(renderChatMarkdown([], opts)).toContain('No messages yet.');
  });

  it('notes the cap', () => {
    expect(renderChatMarkdown([user(1, 'x')], { ...opts, capped: true })).toContain(
      'Only the first 1 messages',
    );
  });
});

describe('exportFileName', () => {
  it('sanitises the agent name', () => {
    const day = new Date(2026, 10, 4);
    expect(exportFileName('My Agent/../..', day)).toBe('my-agent-chat-2026-11-04.md');
    expect(exportFileName('***', day)).toBe('agent-chat-2026-11-04.md');
    expect(exportFileName('Café Bot', day)).toBe('cafe-bot-chat-2026-11-04.md');
  });
});

function pagedApi(total: number): ExportPageSource & { calls: number } {
  const all = Array.from({ length: total }, (_, index) => user(index + 1, `m${index + 1}`));
  const api = {
    calls: 0,
    listMessages: vi.fn((_: string, options: { afterRev: number; limit: number }) => {
      api.calls += 1;
      const messages = all.filter((m) => m.rev > options.afterRev).slice(0, options.limit);
      const last = messages.at(-1);
      return Promise.resolve({ messages, hasMore: last !== undefined && last.rev < total });
    }),
  };
  return api;
}

describe('collectThread', () => {
  it('pages to the end', async () => {
    const api = pagedApi(250);
    const progress: number[] = [];
    const result = await collectThread(api, AGENT, { onProgress: (n) => progress.push(n) });
    expect(result.messages).toHaveLength(250);
    expect(result.capped).toBe(false);
    expect(api.calls).toBe(3);
    expect(progress).toEqual([100, 200, 250]);
  });

  it('stops at the cap', async () => {
    const api = pagedApi(500);
    const result = await collectThread(api, AGENT, { cap: 150 });
    expect(result.messages).toHaveLength(150);
    expect(result.capped).toBe(true);
    expect(api.calls).toBe(2);
  });

  it('stops paging when aborted', async () => {
    const api = pagedApi(500);
    const controller = new AbortController();
    await expect(
      collectThread(api, AGENT, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.calls).toBe(1);
  });

  it('handles an empty chat', async () => {
    const result = await collectThread(pagedApi(0), AGENT);
    expect(result).toEqual({ messages: [], capped: false });
  });
});
