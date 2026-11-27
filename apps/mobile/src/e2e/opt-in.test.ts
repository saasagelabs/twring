import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import type { TrustedDevice } from './pairing';
import {
  confirmPrivateCopy,
  PAIR_AGAIN,
  showPrivateRow,
  turnOnPrivate,
  UPDATE_COMPUTER,
} from './private-state';
import { hasVoiceConsent, VOICE_CONSENT_KEY } from './voice-consent';

const computerAgent = { protocol: 'cord-connector' as const };
const mcpAgent = { protocol: 'mcp-app' as const };
const computer = (): TrustedDevice => ({
  id: 'dev_' + 'c'.repeat(20),
  kind: 'computer',
  name: 'Computer',
  public_key: 'A'.repeat(43),
  verified_at: '2026-11-25T00:00:00.000Z',
});
const endpointUrl = `cord-connector://con_${'a'.repeat(20)}/claude`;
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
    const res = await turnOnPrivate({ agentId: 'a1', endpointUrl, trusted: [], nav, api });
    expect(nav.pushed).toBe('/private/pair?agentId=a1');
    expect(res.status).toBe('pair');
    expect(api.setPrivate).not.toHaveBeenCalled();
  });

  it('turns on with a paired computer', async () => {
    const api = { setPrivate: vi.fn().mockResolvedValue(undefined) };
    const res = await turnOnPrivate({
      agentId: 'a1',
      endpointUrl,
      trusted: [computer()],
      nav: fakeNav(),
      api,
    });
    expect(api.setPrivate).toHaveBeenCalledWith('a1');
    expect(res.status).toBe('on');
  });

  it('a chat made private again asks again before voice notes', async () => {
    const map = new Map([[VOICE_CONSENT_KEY, JSON.stringify(['a1', 'a2'])]]);
    const consent = {
      getItemAsync: (key: string) => Promise.resolve(map.get(key) ?? null),
      setItemAsync: (key: string, value: string) => Promise.resolve(void map.set(key, value)),
      deleteItemAsync: (key: string) => Promise.resolve(void map.delete(key)),
    };
    const res = await turnOnPrivate({
      agentId: 'a1',
      endpointUrl,
      trusted: [computer()],
      nav: fakeNav(),
      api: { setPrivate: vi.fn().mockResolvedValue(undefined) },
      consent,
    });
    expect(res.status).toBe('on');
    expect(await hasVoiceConsent(consent, 'a1')).toBe(false);
    expect(await hasVoiceConsent(consent, 'a2')).toBe(true);
  });

  it('explains an old computer', async () => {
    const api = {
      setPrivate: vi
        .fn()
        .mockRejectedValue(new ApiError('http', 'private_unsupported', undefined, undefined, 409)),
    };
    const res = await turnOnPrivate({
      agentId: 'a1',
      endpointUrl,
      trusted: [computer()],
      nav: fakeNav(),
      api,
    });
    expect(res).toEqual({ status: 'failed', message: UPDATE_COMPUTER });
    expect(res.message).toBe('Update Twring on your computer first, then try again.');
  });

  it('says what happened on any other failure', async () => {
    const api = { setPrivate: vi.fn().mockRejectedValue(new ApiError('network')) };
    const res = await turnOnPrivate({
      agentId: 'a1',
      endpointUrl,
      trusted: [computer()],
      nav: fakeNav(),
      api,
    });
    expect(res.status).toBe('failed');
    expect(res.message).toMatch(/connection/i);
  });

  it('says plainly that older messages stay as they are, with no jargon', () => {
    const copy = confirmPrivateCopy('Claude');
    expect(copy.body).toContain('Older messages stay as they are.');
    expect(JSON.stringify(copy)).not.toMatch(/encrypt|end-to-end|MCP|connector|twring-connect/i);
  });

  it('has the pair again copy', () => {
    expect(PAIR_AGAIN).toBe('Pair your computer again');
  });
});
