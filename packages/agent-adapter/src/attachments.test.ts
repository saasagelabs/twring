import { describe, expect, it } from 'vitest';
import type { TurnAttachment, UserTurn } from '@twring/contracts';
import { NativeWsAdapter } from './native-adapter';
import { RestSseAdapter } from './rest-sse-adapter';
import { startFakeNativeServer } from './fake-native-server';
import { startFakeRestServer } from './fake-rest-server';

const attachment: TurnAttachment = {
  id: 'fil_aaaaaaaaaaaaaaaaaaaa',
  name: 'report.pdf',
  mime_type: 'application/pdf',
  size_bytes: 3,
  url: 'https://server.example/file',
  expires_at: '2026-10-14T00:15:00.000Z',
};
const turn = (attachments?: TurnAttachment[]): UserTurn => ({
  callId: 'c',
  sessionId: 's',
  turnId: attachments ? 'with' : 'without',
  role: 'user',
  text: 'hello',
  surface: 'text',
  startedAt: 'now',
  committedAt: 'now',
  attachments,
});
async function collect(stream: AsyncIterable<unknown>) {
  for await (const event of stream) void event;
}

describe('signed attachment forwarding', () => {
  it('sends native attachments only when present', async () => {
    const server = await startFakeNativeServer({ mode: 'instant' });
    const adapter = new NativeWsAdapter({ url: server.url });
    try {
      const signal = new AbortController().signal;
      await adapter.connect({ callId: 'c', sessionId: 's' }, signal);
      await collect(adapter.sendTurn(turn([attachment]), signal));
      await collect(adapter.sendTurn(turn([]), signal));
      const frames = server.received.filter((m) => m.type === 'user.turn');
      expect(frames[0]).toHaveProperty('attachments', [attachment]);
      expect(frames[1]).not.toHaveProperty('attachments');
    } finally {
      await adapter.close();
      await server.close();
    }
  });

  it('sends REST attachments only when present', async () => {
    const server = await startFakeRestServer({ mode: 'instant' });
    const adapter = new RestSseAdapter({ url: server.url });
    try {
      const signal = new AbortController().signal;
      await adapter.connect({ callId: 'c', sessionId: 's' }, signal);
      await collect(adapter.sendTurn(turn([attachment]), signal));
      await collect(adapter.sendTurn(turn([]), signal));
      expect(server.received[0]).toHaveProperty('attachments', [attachment]);
      expect(server.received[1]).not.toHaveProperty('attachments');
    } finally {
      await adapter.close();
      await server.close();
    }
  });
});
