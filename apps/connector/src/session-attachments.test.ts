import { access } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnAttachment } from '@twring/contracts';
import { EventQueue, type LocalAgentAdapter, type LocalAgentEvent } from './events';
import { ChannelSession } from './session';
import type { LocalFile } from './turn-files';

const attachment: TurnAttachment = {
  id: 'fil_aaaaaaaaaaaaaaaaaaaa',
  name: 'note.txt',
  mime_type: 'text/plain',
  size_bytes: 3,
  url: 'https://server.example/file',
  expires_at: '2026-10-14T00:15:00.000Z',
};

class Agent implements LocalAgentAdapter {
  queue = new EventQueue<LocalAgentEvent>();
  files: LocalFile[] | undefined;
  signal: AbortSignal | undefined;
  sendTurn(
    _text: string,
    signal: AbortSignal,
    options?: { files?: LocalFile[] },
  ): AsyncIterable<LocalAgentEvent> {
    this.files = options?.files;
    this.signal = signal;
    signal.addEventListener('abort', () => this.queue.end(), { once: true });
    return this.queue;
  }
  close() {
    this.queue.end();
  }
}

async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
}

async function removed(path: string) {
  for (let n = 0; n < 200; n++) {
    if (
      !(await access(path).then(
        () => true,
        () => false,
      ))
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('file still there');
}

afterEach(() => vi.unstubAllGlobals());

describe('session attachments', () => {
  for (const ending of ['done', 'error', 'cancel'] as const) {
    it(`cleans downloaded files after ${ending}`, async () => {
      const fetcher = vi.fn(() => Promise.resolve(new Response('abc')));
      vi.stubGlobal('fetch', fetcher);
      const agent = new Agent();
      const sent: Record<string, unknown>[] = [];
      const session = new ChannelSession({
        adapter: agent,
        server: 'https://server.example',
        send: (message) => sent.push(message),
      });
      session.handle({
        type: 'user.turn',
        session_id: 's',
        turn_id: 't',
        text: 'see file',
        surface: 'text',
        attachments: [attachment],
        started_at: 'now',
        committed_at: 'now',
      });
      await until(() => agent.files !== undefined);
      const path = agent.files![0]!.path;
      await access(path);
      if (ending === 'done') agent.queue.end();
      if (ending === 'error') agent.queue.end(new Error('failed'));
      if (ending === 'cancel')
        session.handle({ type: 'turn.cancel', turn_id: 't', reason: 'superseded' });
      await until(() => sent.some((message) => message.type === 'done'));
      // Cleanup runs as the turn finishes, just after `done` is sent.
      await removed(path);
      session.close();
    });
  }

  it('ignores attachments on calls', async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response('abc')));
    vi.stubGlobal('fetch', fetcher);
    const agent = new Agent();
    const session = new ChannelSession({
      adapter: agent,
      server: 'https://server.example',
      send: () => undefined,
    });
    session.handle({
      type: 'user.turn',
      session_id: 's',
      turn_id: 't',
      text: 'hello',
      attachments: [attachment],
      started_at: 'now',
      committed_at: 'now',
    });
    await until(() => agent.signal !== undefined);
    expect(agent.files).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    agent.queue.end();
    session.close();
  });
});
