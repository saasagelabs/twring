import { describe, expect, it, vi } from 'vitest';

import type { ErrorCopy } from '@/api/errors';

import { cameOnline, loadNotice } from './load-notices';

const NETWORK: ErrorCopy = {
  message: "Twring couldn't reach its server.",
  retryable: true,
  network: true,
};
const HTTP: ErrorCopy = { message: 'Server error.', retryable: true };

describe('loadNotice', () => {
  it('shows nothing when nothing failed', () => {
    expect(loadNotice([{ error: undefined, reload: vi.fn() }], true)).toBeUndefined();
  });

  it('shows one notice when two loads fail, and its retry reloads both', () => {
    const a = vi.fn();
    const b = vi.fn();
    const notice = loadNotice(
      [
        { error: NETWORK, reload: a },
        { error: NETWORK, reload: b },
      ],
      true,
    );
    expect(notice?.error).toBe(NETWORK);
    notice?.retry();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('hides network failures while the phone is offline', () => {
    expect(loadNotice([{ error: NETWORK, reload: vi.fn() }], false)).toBeUndefined();
  });

  it('still shows other failures while the phone is offline', () => {
    const notice = loadNotice(
      [
        { error: NETWORK, reload: vi.fn() },
        { error: HTTP, reload: vi.fn() },
      ],
      false,
    );
    expect(notice?.error).toBe(HTTP);
  });
});

describe('cameOnline', () => {
  it('is true only on offline to online', () => {
    expect(cameOnline(false, true)).toBe(true);
    expect(cameOnline(true, true)).toBe(false);
    expect(cameOnline(true, false)).toBe(false);
    expect(cameOnline(false, false)).toBe(false);
  });
});
