import { describe, expect, it } from 'vitest';
import { canSend, composerAction, COMPOSER_LIMIT } from './composer-state';
describe('composer', () => {
  it('hides Send for blank text', () => {
    expect(canSend('  \n')).toBe(false);
    expect(canSend('hello')).toBe(true);
  });
  it('caps input at 4,000 characters', () => {
    expect(COMPOSER_LIMIT).toBe(4000);
  });
  it('chooses mic, send, or no action', () => {
    expect(composerAction(' ', false)).toBe('mic');
    expect(composerAction('hello', false)).toBe('send');
    expect(composerAction('hello', true)).toBe('none');
  });
});
