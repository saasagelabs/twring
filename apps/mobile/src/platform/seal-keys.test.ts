import { describe, expect, it, vi } from 'vitest';

import { createSealKeys } from './seal-keys-core';

describe('createSealKeys', () => {
  it('calls the native functions that exist', async () => {
    const native = {
      setSealKey: vi.fn(),
      removeSealKey: vi.fn(),
      sealSelfTest: vi.fn().mockResolvedValue(false),
    };
    const keys = createSealKeys(native);
    await keys.set('s1', 'k');
    await keys.remove('s1');
    expect(native.setSealKey).toHaveBeenCalledWith('s1', 'k');
    expect(native.removeSealKey).toHaveBeenCalledWith('s1');
    expect(await keys.selfTest()).toBe(false);
  });

  it('is a no-op when the native module or its functions are missing', async () => {
    for (const native of [null, undefined, {}]) {
      const keys = createSealKeys(native);
      await expect(keys.set('s1', 'k')).resolves.toBeUndefined();
      await expect(keys.remove('s1')).resolves.toBeUndefined();
      expect(await keys.selfTest()).toBe(true);
    }
  });
});
