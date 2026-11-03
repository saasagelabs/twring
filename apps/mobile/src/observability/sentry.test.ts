import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileEnvResult } from '@/config/env';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock('@sentry/react-native', () => ({
  init: sentry.init,
  captureException: sentry.captureException,
  captureMessage: sentry.captureMessage,
  addBreadcrumb: sentry.addBreadcrumb,
  wrap: (component: unknown) => component,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { initSentry, reportAudioEvent, reportClientError } from './sentry';

describe('reportClientError', () => {
  beforeEach(() => sentry.captureException.mockClear());

  it('does nothing before initialization', () => {
    reportClientError('voice_permission', new Error('denied'));
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('tags failures and keeps the native message without paths or emails', () => {
    const env = {
      ok: true,
      env: { SENTRY_DSN: 'https://example.invalid', CORD_ENV: 'development' },
    } as MobileEnvResult;
    initSentry(env);
    reportClientError('voice_prepare', new Error('file:///private/audio.m4a ann@example.com'));
    const [error, options] = sentry.captureException.mock.calls[0] as [
      Error,
      { tags: Record<string, string> },
    ];
    expect(error.message).toBe('voice_prepare: Error: [path] [email]');
    expect(options.tags).toEqual({ stage: 'voice_prepare', platform: 'ios' });
    expect(error.message).not.toContain('audio.m4a');
  });
});

describe('reportAudioEvent', () => {
  beforeEach(() => {
    initSentry({
      ok: true,
      env: { SENTRY_DSN: 'https://example.invalid', CORD_ENV: 'development' },
    } as MobileEnvResult);
    sentry.captureMessage.mockClear();
    sentry.addBreadcrumb.mockClear();
  });

  it('a Speaker or Phone switch that keeps the call audio is a breadcrumb, not a warning', () => {
    reportAudioEvent({
      kind: 'route',
      reason: 'category_change',
      category: 'AVAudioSessionCategoryPlayAndRecord',
      output: 'Speaker',
    });
    expect(sentry.addBreadcrumb).toHaveBeenCalledOnce();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('a switch that leaves no audio output at all is still reported', () => {
    reportAudioEvent({
      kind: 'route',
      reason: 'category_change',
      category: 'AVAudioSessionCategoryPlayAndRecord',
      output: 'none',
    });
    expect(sentry.captureMessage).toHaveBeenCalledOnce();
  });

  it('a category change that leaves call audio is still reported', () => {
    reportAudioEvent({
      kind: 'route',
      reason: 'category_change',
      category: 'AVAudioSessionCategoryAmbient',
    });
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      'call_audio_route_category_change',
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('interruptions and a missing route are still reported', () => {
    reportAudioEvent({ kind: 'interruption', reason: 'began' });
    reportAudioEvent({ kind: 'route', reason: 'no_route' });
    expect(sentry.captureMessage).toHaveBeenCalledTimes(2);
  });
});
