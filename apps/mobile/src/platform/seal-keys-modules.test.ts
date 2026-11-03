import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireOptionalNativeModule = vi.fn(() => null);
vi.mock('expo', () => ({ requireOptionalNativeModule }));

describe('seal key native module names', () => {
  beforeEach(() => {
    vi.resetModules();
    requireOptionalNativeModule.mockClear();
  });

  it('asks for CordCallService on Android', async () => {
    await import('./seal-keys.android');
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('CordCallService');
  });

  it('asks for CordRing on iOS', async () => {
    await import('./seal-keys.ios');
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('CordRing');
  });
});
