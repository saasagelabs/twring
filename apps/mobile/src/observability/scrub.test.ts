import type { ErrorEvent } from '@sentry/react-native';
import { describe, expect, it } from 'vitest';

import { clientErrorMessage, hashUserId, scrubBreadcrumb, scrubEvent, scrubText } from './scrub';

const JWT =
  'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZW1haWwiOiJhQGIuY28ifQ.c2lnbmF0dXJlLXBhcnQ';
const USER_ID = '0b4a3f5e-8c2d-4e1f-9a7b-6c5d4e3f2a1b';

const STRIPE = ['sk', 'live', '0123456789abcdefghijklmnopqrstuv'].join('_');

describe('scrubText', () => {
  it('removes emails, tokens, and long secrets', () => {
    const text = `user ann@example.com sent Bearer abc.def-123 ${JWT} token=s3cr3t&x=1 key ${STRIPE}`;
    const scrubbed = scrubText(text);
    expect(scrubbed).not.toContain('ann@example.com');
    expect(scrubbed).not.toContain('abc.def-123');
    expect(scrubbed).not.toContain('eyJ');
    expect(scrubbed).not.toContain('s3cr3t');
    expect(scrubbed).not.toContain('0123456789abcdefghijklmnopqrstuv');
    expect(scrubbed).toContain('[email]');
  });

  it('leaves ordinary words alone', () => {
    expect(scrubText('LiveKit connect failed after 3 retries')).toBe(
      'LiveKit connect failed after 3 retries',
    );
  });
});

describe('hashUserId', () => {
  it('is stable, one-way looking, and never contains the id', () => {
    const hash = hashUserId(USER_ID);
    expect(hash).toBe(hashUserId(USER_ID));
    expect(hash).toMatch(/^u_[0-9a-f]{16}$/);
    expect(hash).not.toContain(USER_ID.slice(0, 8));
    expect(hashUserId('other')).not.toBe(hash);
  });
});

describe('scrubEvent', () => {
  it('drops PII, request data, and transcript-like text; keeps the hashed user and call ids', () => {
    const event = {
      type: undefined,
      message: 'failed for ann@example.com',
      user: { id: hashUserId(USER_ID), email: 'ann@example.com', ip_address: '203.0.113.9' },
      extra: { transcript: 'please transfer the money' },
      request: {
        url: 'https://api.example/v1/calls?token=abc',
        headers: { authorization: `Bearer ${JWT}` },
        data: { text: 'please transfer the money' },
      },
      exception: { values: [{ type: 'Error', value: `401 for ${JWT}` }] },
      breadcrumbs: [
        { category: 'console', message: 'Agent said: please transfer the money' },
        {
          category: 'call',
          message: 'call_failed',
          data: { call_id: 'call_0123456789abcdefghijklmnopqrstuvwx', detail: `ann@example.com` },
        },
      ],
    } as ErrorEvent;
    const scrubbed = scrubEvent(event);
    const json = JSON.stringify(scrubbed);
    expect(json).not.toContain('ann@example.com');
    expect(json).not.toContain('transfer the money');
    expect(json).not.toContain('eyJ');
    expect(json).not.toContain('203.0.113.9');
    expect(json).not.toContain(USER_ID);
    expect(scrubbed.user).toEqual({ id: hashUserId(USER_ID) });
    expect(scrubbed.request?.url).toBe('https://api.example/v1/calls');
    expect(scrubbed.breadcrumbs?.[0]).toEqual({ category: 'console' });
    expect(scrubbed.breadcrumbs?.[1]?.data?.call_id).toBe(
      'call_0123456789abcdefghijklmnopqrstuvwx',
    );
  });

  it('drops a user that is not a hash', () => {
    const scrubbed = scrubEvent({ type: undefined, user: { id: USER_ID } });
    expect(scrubbed.user).toBeUndefined();
  });

  it('strips non-call breadcrumbs', () => {
    expect(scrubBreadcrumb({ category: 'xhr', data: { url: 'https://x/?k=v' } })).toEqual({
      category: 'xhr',
    });
  });
});

describe('clientErrorMessage', () => {
  it('keeps the native message but drops file paths and secrets', () => {
    expect(
      clientErrorMessage(
        new Error('Recording failed at file:///var/mobile/Containers/Data/x.m4a token=abc'),
      ),
    ).toBe('Error: Recording failed at [path] token=[redacted]');
    expect(clientErrorMessage('plain')).toBe('plain');
    expect(clientErrorMessage(42)).toBe('UnknownError');
  });
});
