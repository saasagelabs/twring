import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  present: true,
  clear: undefined as undefined | ((id: string) => void),
  visible: undefined as undefined | ((id: string | null) => void),
}));
vi.mock('expo', () => ({
  requireOptionalNativeModule: () =>
    native.present ? { clearMessages: native.clear, setVisibleChat: native.visible } : null,
}));
vi.mock('react-native', () => ({ PermissionsAndroid: {}, Platform: { Version: 34 } }));

beforeEach(() => {
  native.present = true;
  native.clear = undefined;
  native.visible = undefined;
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

describe('visible chat', () => {
  it('tells native which chat is on screen and tolerates old or missing modules', async () => {
    const ids: (string | null)[] = [];
    native.visible = (id) => ids.push(id);
    vi.resetModules();
    const current = (await import('./ring.android')).ringPlatform;
    current.setVisibleChat('agt_123');
    current.setVisibleChat(null);
    expect(ids).toEqual(['agt_123', null]);
    native.visible = () => {
      throw new Error('refused');
    };
    vi.resetModules();
    const throwing = await import('./ring.android');
    expect(() => throwing.ringPlatform.setVisibleChat('agt_123')).not.toThrow();
    native.visible = undefined;
    vi.resetModules();
    const oldBuild = await import('./ring.android');
    expect(() => oldBuild.ringPlatform.setVisibleChat('agt_123')).not.toThrow();
    native.present = false;
    vi.resetModules();
    const missing = await import('./ring.android');
    expect(() => missing.ringPlatform.setVisibleChat(null)).not.toThrow();
  });
});
