/* eslint-disable @typescript-eslint/require-await -- fakes mirror async APIs */
import type { ThreadMessage } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

const written = vi.hoisted(() => ({ text: '' }));
vi.mock('expo-file-system', () => ({
  Paths: { cache: 'cache' },
  File: class {
    uri = 'cache/x.md';
    exists = false;
    write(text: string) {
      written.text = text;
    }
    delete() {}
  },
}));
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync: async () => {} }));

import type { OpenedMessage } from '../e2e/sealed-thread';
import { exportChat } from './export-chat';
import { COULDNT_OPEN_EXPORT, renderChatMarkdown } from './export-markdown';

const at = '2026-11-25T10:00:00.000Z';
const sealed = (id: string, seq: number, author: 'user' | 'agent') =>
  ({
    id,
    agent_id: 'agt_aaaaaaaaaaaaaaaaaaaa',
    seq,
    rev: seq,
    created_at: at,
    updated_at: at,
    kind: 'sealed',
    author,
    sealed: [],
  }) as unknown as ThreadMessage;
const A = 'msg_' + 'a'.repeat(20);
const B = 'msg_' + 'b'.repeat(20);

describe('exporting a private chat on the phone (Task 23)', () => {
  it('exports opened text and never calls a server export', async () => {
    const api = {
      listMessages: vi.fn(async () => ({
        messages: [sealed(A, 1, 'agent'), sealed(B, 2, 'user')],
        hasMore: false,
      })),
    };
    const opened: OpenedMessage[] = [
      { id: A, author: 'agent', state: 'ok', text: 'hello from computer' },
      { id: B, author: 'user', state: 'couldnt_open' },
    ];
    const open = vi.fn(async () => opened);
    await exportChat(
      api,
      { id: 'agt_aaaaaaaaaaaaaaaaaaaa', name: 'Claude' },
      { signal: new AbortController().signal, onProgress: () => undefined, open },
    );
    expect(written.text).toContain('> hello from computer');
    expect(written.text).toContain(COULDNT_OPEN_EXPORT);
    expect(written.text).not.toContain('not exported');
    expect(Object.keys(api)).toEqual(['listMessages']);
  });

  it('every sealed message the phone could not open says so', () => {
    const md = renderChatMarkdown([sealed(A, 1, 'agent'), sealed(B, 2, 'user')], {
      agentName: 'Claude',
      exportedAt: new Date(at),
      formatTime: () => 't',
      opened: new Map(),
    });
    expect(COULDNT_OPEN_EXPORT).toBe("(Couldn't open this message)");
    expect(md).toBe(
      [
        '# Chat with Claude',
        '',
        'Exported 2026-11-25',
        '',
        '**Claude** (t):',
        '',
        COULDNT_OPEN_EXPORT,
        '',
        '**You** (t):',
        '',
        COULDNT_OPEN_EXPORT,
        '',
      ].join('\n'),
    );
  });
});
