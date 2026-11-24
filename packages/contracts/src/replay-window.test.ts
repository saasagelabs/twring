import { describe, expect, it } from 'vitest';

import { ReplayWindow } from './replay-window';

describe('ReplayWindow', () => {
  it('starts from the highest seq saved before a restart', () => {
    const window = new ReplayWindow({ dev_a: 10 });
    expect(window.accept('dev_a', 10)).toBe(false);
    expect(window.accept('dev_a', 3)).toBe(false);
    expect(window.accept('dev_a', 11)).toBe(true);
    expect(window.highest()).toEqual({ dev_a: 11 });
  });

  it('refuses a seq older than the window', () => {
    const window = new ReplayWindow();
    expect(window.accept('dev_a', 100)).toBe(true);
    expect(window.accept('dev_a', 36)).toBe(false);
    expect(window.accept('dev_a', 37)).toBe(true);
  });

  it('takes every chunk of one reply once: they share a seq, each index is its own', () => {
    const window = new ReplayWindow();
    expect(window.accept('dev_a', 5, 0)).toBe(true);
    expect(window.accept('dev_a', 5, 1)).toBe(true);
    expect(window.accept('dev_a', 5, 2)).toBe(true);
    expect(window.fresh('dev_a', 5, 1)).toBe(false);
    expect(window.accept('dev_a', 5, 1)).toBe(false);
    expect(window.accept('dev_a', 6, 0)).toBe(true);
    expect(window.highest()).toEqual({ dev_a: 6 });
  });

  it('seeds every chunk index from the saved seq', () => {
    const window = new ReplayWindow({ dev_a: 10 });
    expect(window.accept('dev_a', 10, 3)).toBe(false);
    expect(window.accept('dev_a', 11, 3)).toBe(true);
  });

  it('keeps a message without chunks apart from chunk 0 of the same seq', () => {
    const window = new ReplayWindow();
    expect(window.accept('dev_a', 1)).toBe(true);
    expect(window.accept('dev_a', 1, 0)).toBe(true);
    expect(window.accept('dev_a', 1)).toBe(false);
  });
});
