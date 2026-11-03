import type { ThreadMessage } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type TwringApi } from '../api/client';

vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('@/api', () => ({ ApiError }));
vi.mock('@/auth', () => ({ addBeforeSignOut: () => undefined, authHeaders: () => ({}) }));
vi.mock('@/config/env', () => ({ mobileEnv: { ok: false } }));
vi.mock('@/hooks/useResource', () => ({ STATUS_POLL_MS: 20_000 }));

import { ChatController } from './chats';

const agent = 'agt_abcdefghij0123456789';
const message = (seq: number, rev: number): ThreadMessage => ({
  id: `msg_${String.fromCharCode(97 + seq).repeat(20)}`,
  agent_id: agent,
  seq,
  rev,
  kind: 'user_text',
  text: 'hello',
  status: 'sent',
  client_id: '123e4567-e89b-42d3-a456-426614174000',
  created_at: '2026-10-13T00:00:00.000Z',
  updated_at: '2026-10-13T00:00:00.000Z',
});

describe('chat controller', () => {
  it('pages catch-up with the latest revision cursor', async () => {
    const listMessages = vi
      .fn<TwringApi['listMessages']>()
      .mockResolvedValueOnce({ messages: [message(1, 2), message(2, 3)], hasMore: true })
      .mockResolvedValueOnce({ messages: [message(3, 5)], hasMore: false });
    const controller = new ChatController({ listMessages } as unknown as TwringApi);
    await controller.catchUp(agent);
    expect(listMessages.mock.calls.map((call) => call[1]?.afterRev)).toEqual([0, 3]);
    expect(controller.getChat(agent).messages.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(controller.getChat(agent).maxRev).toBe(5);
  });
  it('caches a 404 as unavailable and keeps other responses available', async () => {
    const listThreads = vi
      .fn()
      .mockRejectedValue(new ApiError('http', undefined, undefined, undefined, 404));
    const unavailable = new ChatController({ listThreads } as unknown as TwringApi);
    await unavailable.refreshList();
    await unavailable.refreshList();
    expect(unavailable.getAvailability()).toBe(false);
    expect(listThreads).toHaveBeenCalledTimes(1);
    const available = new ChatController({
      listThreads: vi.fn().mockResolvedValue({ threads: [], files: true }),
    } as unknown as TwringApi);
    await available.refreshList();
    expect(available.getFilesAvailable()).toBe(true);
    expect(available.getAvailability()).toBe(true);
  });
});

describe('device test 2026-10-13', () => {
  it('shows a sent message from the server reply, without the socket', async () => {
    const sent = message(1, 1);
    const sendMessage = vi
      .fn<TwringApi['sendMessage']>()
      .mockImplementation((_agent, request) =>
        Promise.resolve({ ...sent, client_id: request.clientId } as ThreadMessage),
      );
    const controller = new ChatController({ sendMessage } as unknown as TwringApi);
    controller.send(agent, 'hello');
    await vi.waitFor(() => expect(controller.getChat(agent).messages).toHaveLength(1));
    expect(controller.getPending(agent)).toEqual([]);
  });
});
