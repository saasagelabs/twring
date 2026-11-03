import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  present: true,
  clear: undefined as undefined | ((id: string) => void),
}));
vi.mock('expo', () => ({
  requireOptionalNativeModule: () => (native.present ? { clearMessages: native.clear } : null),
}));
vi.mock('react-native', () => ({ PermissionsAndroid: {}, Platform: { Version: 34 } }));

beforeEach(() => {
  native.present = true;
  native.clear = undefined;
});

describe('message notification clearing', () => {
  it('calls native when available and tolerates old or missing modules', async () => {
    const ids: string[] = [];
    native.clear = (id) => ids.push(id);
    vi.resetModules();
    (await import('./ring.android')).ringPlatform.clearMessages('agt_123');
    expect(ids).toEqual(['agt_123']);
    native.clear = undefined;
    vi.resetModules();
    const oldBuild = await import('./ring.android');
    expect(() => oldBuild.ringPlatform.clearMessages('agt_123')).not.toThrow();
    native.present = false;
    vi.resetModules();
    const missing = await import('./ring.android');
    expect(() => missing.ringPlatform.clearMessages('agt_123')).not.toThrow();
  });
});
