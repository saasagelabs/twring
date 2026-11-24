import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import type { TrustedDevice } from './pairing';
import {
  confirmPrivateCopy,
  needsPairAgain,
  PAIR_AGAIN,
  showPrivateRow,
  turnOnPrivate,
  UPDATE_COMPUTER,
} from './private-state';

const computerAgent = { protocol: 'cord-connector' as const };
const mcpAgent = { protocol: 'mcp-app' as const };
const computer = (): TrustedDevice => ({
  id: 'dev_' + 'c'.repeat(20),
  kind: 'computer',
  name: 'Computer',
  public_key: 'A'.repeat(43),
  verified_at: '2026-11-25T00:00:00.000Z',
});
const fakeNav = () => {
  const nav = { pushed: undefined as string | undefined, push: (to: string) => (nav.pushed = to) };
  return nav;
};

describe('turning on private chats for one computer agent', () => {
  it('hides the option when the server flag is off', () => {
    expect(showPrivateRow({ available: false, agent: computerAgent })).toBe(false);
    expect(showPrivateRow({ available: true, agent: computerAgent })).toBe(true);
  });

  it('hides the option for an online AI app and any other agent', () => {
    expect(showPrivateRow({ available: true, agent: mcpAgent })).toBe(false);
    expect(showPrivateRow({ available: true, agent: { protocol: 'openai-chat' } })).toBe(false);
  });

  it('pairs first, then turns on', async () => {
    const nav = fakeNav();
    const api = { setPrivate: vi.fn() };
    const res = await turnOnPrivate({ agentId: 'a1', trusted: [], nav, api });
    expect(nav.pushed).toBe('/private/pair?agentId=a1');
    expect(res.status).toBe('pair');
    expect(api.setPrivate).not.toHaveBeenCalled();
  });

  it('turns on with a paired computer', async () => {
    const api = { setPrivate: vi.fn().mockResolvedValue(undefined) };
    const res = await turnOnPrivate({ agentId: 'a1', trusted: [computer()], nav: fakeNav(), api });
    expect(api.setPrivate).toHaveBeenCalledWith('a1');
    expect(res.status).toBe('on');
  });

  it('explains an old computer', async () => {
    const api = {
      setPrivate: vi
        .fn()
        .mockRejectedValue(new ApiError('http', 'private_unsupported', undefined, undefined, 409)),
    };
    const res = await turnOnPrivate({ agentId: 'a1', trusted: [computer()], nav: fakeNav(), api });
    expect(res).toEqual({ status: 'failed', message: UPDATE_COMPUTER });
    expect(res.message).toBe('Update Twring on your computer first, then try again.');
  });

  it('says what happened on any other failure', async () => {
    const api = { setPrivate: vi.fn().mockRejectedValue(new ApiError('network')) };
    const res = await turnOnPrivate({ agentId: 'a1', trusted: [computer()], nav: fakeNav(), api });
    expect(res.status).toBe('failed');
    expect(res.message).toMatch(/connection/i);
  });

  it('says plainly that older messages stay as they are, with no jargon', () => {
    const copy = confirmPrivateCopy('Claude');
    expect(copy.body).toContain('Older messages stay as they are.');
    expect(JSON.stringify(copy)).not.toMatch(/encrypt|end-to-end|MCP|connector|twring-connect/i);
  });

  it('asks to pair again when a private chat has no computer to seal to', () => {
    expect(needsPairAgain(true, [])).toBe(true);
    expect(needsPairAgain(true, [computer()])).toBe(false);
    expect(needsPairAgain(false, [])).toBe(false);
    expect(PAIR_AGAIN).toBe('Pair your computer again');
  });
});
