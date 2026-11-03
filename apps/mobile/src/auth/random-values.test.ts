import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({ getRandomValues: vi.fn(<T>(array: T) => array) }));

import { installRandomValues } from './random-values';

describe('installRandomValues', () => {
  it('adds getRandomValues to a crypto that only has randomUUID (LiveKit registerGlobals)', () => {
    const randomUUID = () => 'uuid';
    const target: Parameters<typeof installRandomValues>[0] & {
      crypto?: { randomUUID?: () => string };
    } = { crypto: { randomUUID } };
    const seen: unknown[] = [];
    installRandomValues(target, <T>(array: T) => {
      seen.push(array);
      return array;
    });
    const bytes = new Uint32Array(4);
    expect(target.crypto?.getRandomValues?.(bytes)).toBe(bytes);
    expect(seen).toEqual([bytes]);
    expect(target.crypto?.randomUUID).toBe(randomUUID);
  });

  it('creates crypto when there is none, and keeps a real getRandomValues', () => {
    const empty: Parameters<typeof installRandomValues>[0] = {};
    installRandomValues(empty, <T>(array: T) => array);
    expect(typeof empty.crypto?.getRandomValues).toBe('function');

    const real = <T>(array: T) => array;
    const native = { crypto: { getRandomValues: real } };
    installRandomValues(native, <T>(array: T) => array);
    expect(native.crypto.getRandomValues).toBe(real);
  });
});
