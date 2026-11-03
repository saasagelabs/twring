import { describe, expect, it } from 'vitest';
import { canSend, composerAction } from './composer-state';

describe('composer action', () => {
  it('sends text, files, or both, and only shows mic when empty', () => {
    expect(canSend('   ', 0)).toBe(false);
    expect(canSend('   ', 1)).toBe(true);
    expect(composerAction('', false, 0)).toBe('mic');
    expect(composerAction('', false, 1)).toBe('send');
    expect(composerAction('hello', false, 1)).toBe('send');
    expect(composerAction('hello', true, 1)).toBe('none');
  });
});
