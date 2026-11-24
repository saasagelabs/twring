/* eslint-disable @typescript-eslint/require-await -- fakes mirror async APIs */
import type { ThreadMessage } from '@twring/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({ files: new Set<string>(), writes: 0, failWrite: false }));
const sharing = vi.hoisted(() => ({
  available: true,
  shareAsync: vi.fn<(uri: string) => Promise<void>>(async () => undefined),
}));

vi.mock('expo-file-system', () => ({
  Paths: { cache: 'cache' },
  File: class {
    uri: string;
    constructor(dir: string, name: string) {
      this.uri = `${dir}/${name}`;
    }
    get exists() {
      return fs.files.has(this.uri);
    }
    write() {
      if (fs.failWrite) throw new Error('disk full');
      fs.writes += 1;
      fs.files.add(this.uri);
    }
    delete() {
      if (!fs.files.delete(this.uri)) throw new Error('missing');
    }
  },
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => sharing.available,
  shareAsync: (uri: string) => sharing.shareAsync(uri),
}));

import { exportChat } from './export-chat';
import { collectThread, exportFileName, renderChatMarkdown } from './export-markdown';

const AGENT = 'agt_aaaaaaaaaaaaaaaaaaaa';
function msg(seq: number, text: string, created_at = '2026-11-24T10:00:00.000Z'): ThreadMessage {
  return {
    id: `msg_${seq}`,
    agent_id: AGENT,
    seq,
    rev: seq,
    created_at,
    updated_at: created_at,
    kind: 'agent_text',
    text,
    cut: false,
    partial: false,
  };
}
const opts = { agentName: 'Hermes', exportedAt: new Date(2026, 10, 24) };

/** Every line of the message region must be inside the quote. */
function quotedBody(md: string): string[] {
  const start = md.indexOf('**Hermes**');
  return md
    .slice(start)
    .split('\n')
    .slice(2)
    .filter((line) => line.length);
}

describe('markdown injection', () => {
  it.each([
    ['heading', 'hi\n# heading'],
    ['fence', '```js\nalert(1)\n```\n# after'],
    ['quote marker', '> fake quote\n>> deeper'],
    ['html', '<script>x</script>\n<div>'],
    ['crlf', 'a\r\n# b\rc'],
    ['unicode separators', 'a\u2028# b\u2029c'],
  ])('%s stays inside the quote', (_name, text) => {
    const md = renderChatMarkdown([msg(1, text)], opts);
    for (const line of quotedBody(md)) expect(line.startsWith('>')).toBe(true);
    expect(md).not.toMatch(/\r/);
  });
});

describe('timestamps', () => {
  it('uses the local clock', () => {
    const iso = new Date(2026, 0, 2, 3, 4).toISOString();
    expect(renderChatMarkdown([msg(1, 'x', iso)], opts)).toContain('(2026-01-02 03:04)');
  });
  it.each(['', 'not a date', undefined as unknown as string])(
    'an invalid date %j does not throw or print NaN',
    (created) => {
      const md = renderChatMarkdown([msg(1, 'x', created)], opts);
      expect(md).not.toContain('NaN');
    },
  );
});

describe('exportFileName', () => {
  const day = new Date(2026, 10, 24);
  it.each([
    ['\u{1F916}\u{1F680}', 'agent-chat-2026-11-24.md'],
    ['', 'agent-chat-2026-11-24.md'],
    ['   ', 'agent-chat-2026-11-24.md'],
    ['../../etc/passwd', 'etc-passwd-chat-2026-11-24.md'],
    ['a/b' + String.fromCharCode(92) + 'c', 'a-b-c-chat-2026-11-24.md'],
    ['Caf\u00e9 Bot', 'cafe-bot-chat-2026-11-24.md'],
  ])('%j -> %s', (name, expected) => {
    expect(exportFileName(name, day)).toBe(expected);
  });
  it('caps a very long name', () => {
    const name = exportFileName('x'.repeat(5000), day);
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name).toMatch(/^[a-z0-9-]+-chat-2026-11-24\.md$/);
  });
});

describe('collectThread', () => {
  it('stops when a page never advances the cursor (no endless loop)', async () => {
    const listMessages = vi.fn(async () => ({ messages: [msg(1, 'a')], hasMore: true }));
    const result = await collectThread({ listMessages }, AGENT, { cap: 100 });
    expect(result.messages).toHaveLength(1);
    expect(listMessages).toHaveBeenCalledTimes(2);
  });
});

describe('exportChat', () => {
  beforeEach(() => {
    fs.files.clear();
    fs.writes = 0;
    fs.failWrite = false;
    sharing.available = true;
    sharing.shareAsync.mockReset().mockResolvedValue(undefined);
  });
  const agent = { id: AGENT, name: 'Hermes' };

  it('a page that fails mid-way shares nothing and writes no file', async () => {
    let call = 0;
    const api = {
      listMessages: vi.fn(async () => {
        call += 1;
        if (call === 2) throw new Error('network');
        return { messages: [msg(1, 'a')].map((m) => ({ ...m, rev: call })), hasMore: true };
      }),
    };
    await expect(
      exportChat(api, agent, { signal: new AbortController().signal, onProgress: vi.fn() }),
    ).rejects.toThrow('network');
    expect(sharing.shareAsync).not.toHaveBeenCalled();
    expect(fs.writes).toBe(0);
  });

  it('abort while paging rejects with AbortError and leaves no file', async () => {
    const controller = new AbortController();
    const api = {
      listMessages: vi.fn(async () => {
        controller.abort();
        return { messages: [msg(1, 'a')], hasMore: true };
      }),
    };
    await expect(
      exportChat(api, agent, { signal: controller.signal, onProgress: vi.fn() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.files.size).toBe(0);
    expect(sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('deletes the temp file after sharing and after a share failure', async () => {
    const api = { listMessages: vi.fn(async () => ({ messages: [msg(1, 'a')], hasMore: false })) };
    const signal = new AbortController().signal;
    await exportChat(api, agent, { signal, onProgress: vi.fn() });
    expect(fs.files.size).toBe(0);
    sharing.shareAsync.mockRejectedValueOnce(new Error('sheet failed'));
    await expect(exportChat(api, agent, { signal, onProgress: vi.fn() })).rejects.toThrow();
    expect(fs.files.size).toBe(0);
  });

  it('a write failure rejects and does not share', async () => {
    fs.failWrite = true;
    const api = { listMessages: vi.fn(async () => ({ messages: [], hasMore: false })) };
    await expect(
      exportChat(api, agent, { signal: new AbortController().signal, onProgress: vi.fn() }),
    ).rejects.toThrow('disk full');
    expect(sharing.shareAsync).not.toHaveBeenCalled();
  });
});
