import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
  const state: { present: boolean; module: Record<string, unknown> } = {
    present: true,
    module: {},
  };
  return state;
});
vi.mock('expo', () => ({
  requireOptionalNativeModule: () => (native.present ? native.module : null),
}));

beforeEach(() => {
  native.present = true;
  native.module = {};
  vi.resetModules();
});

describe('iOS ring platform', () => {
  it('asks only for alert permission: CallKit needs no full-screen or channel setting', async () => {
    native.module = { alertsAllowed: () => true };
    const { ringPlatform } = await import('./ring.ios');
    expect(ringPlatform.supported).toBe(true);
    expect(ringPlatform.permissions()).toEqual({
      notifications: true,
      fullScreen: true,
      channel: true,
    });
  });

  it('passes the answered ring and system call controls through to native', async () => {
    const ended: string[] = [];
    native.module = {
      takeAnsweredRing: () => ({ invite_id: 'inv_1' }),
      endCall: () => ended.push('end'),
      setMuted: (muted: boolean) => ended.push(`muted ${String(muted)}`),
      notify: (title: string, body: string) => ended.push(`notify ${title}: ${body}`),
    };
    const { ringPlatform } = await import('./ring.ios');
    expect(ringPlatform.takeAnsweredRing?.()).toEqual({ invite_id: 'inv_1' });
    ringPlatform.endSystemCall?.();
    ringPlatform.setSystemCallMuted?.(true);
    ringPlatform.notify?.('Title', 'Why');
    expect(ended).toEqual(['end', 'muted true', 'notify Title: Why']);
  });

  it('never throws when the native module is missing or fails', async () => {
    native.present = false;
    const missing = (await import('./ring.ios')).ringPlatform;
    expect(missing.supported).toBe(false);
    expect(missing.permissions().notifications).toBe(false);
    expect(await missing.getPushToken()).toBeNull();
    expect(missing.takeAnsweredRing?.()).toBeNull();
    expect(() => missing.endSystemCall?.()).not.toThrow();
    expect(() => missing.notify?.('Title', 'Why')).not.toThrow();
    vi.resetModules();
    native.present = true;
    native.module = {
      alertsAllowed: () => {
        throw new Error('native');
      },
    };
    const failing = (await import('./ring.ios')).ringPlatform;
    expect(failing.permissions().notifications).toBe(false);
  });

  it('never opens its own incoming screen for a push: CallKit shows the ring', async () => {
    const { ringPlatform } = await import('./ring.ios');
    const listener = vi.fn();
    const off = ringPlatform.onRing(listener);
    off();
    expect(listener).not.toHaveBeenCalled();
  });
});
