import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
  const state: {
    present: boolean;
    calls: boolean[];
    listener: ((data: Record<string, unknown>) => void) | undefined;
    removed: number;
  } = { present: true, calls: [], listener: undefined, removed: 0 };
  return state;
});
const reported = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('expo', () => ({
  requireOptionalNativeModule: () =>
    native.present
      ? {
          setCallActive: (active: boolean) => native.calls.push(active),
          addListener: (_event: string, listener: (data: Record<string, unknown>) => void) => {
            native.listener = listener;
            return { remove: () => (native.removed += 1) };
          },
        }
      : null,
}));
vi.mock('@/observability/sentry', () => ({
  reportAudioEvent: (data: Record<string, unknown>) => reported.push(data),
}));

beforeEach(() => {
  native.present = true;
  native.calls = [];
  native.listener = undefined;
  native.removed = 0;
  reported.length = 0;
  vi.resetModules();
});

describe('iOS live call', () => {
  it('turns proximity and audio diagnostics on for the call, and off after', async () => {
    const { callBackgroundService } = await import('./call-service.ios');
    callBackgroundService.setCallScreen(true);
    native.listener?.({ kind: 'route', reason: 'category_change', output: 'Receiver' });
    callBackgroundService.setCallScreen(false);
    expect(native.calls).toEqual([true, false]);
    expect(reported).toEqual([{ kind: 'route', reason: 'category_change', output: 'Receiver' }]);
    expect(native.removed).toBe(1);
  });

  it('does nothing, and never throws, without the native module', async () => {
    native.present = false;
    const { callBackgroundService } = await import('./call-service.ios');
    expect(() => callBackgroundService.setCallScreen(true)).not.toThrow();
  });
});
