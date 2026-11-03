import { describe, expect, it } from 'vitest';
import { pickerSelection, takeDismissedPicker, pickerQueue } from './picker-sequence';

describe('picker presentation order', () => {
  it('waits for iOS sheet dismissal', () => {
    const choice = pickerSelection('ios', 'Camera');
    expect(choice.launchNow).toBeNull();
    expect(takeDismissedPicker(choice.pending)).toBe('Camera');
    expect(takeDismissedPicker(null)).toBeNull();
  });

  it('keeps Android presentation immediate', () => {
    expect(pickerSelection('android', 'Photos')).toEqual({ pending: null, launchNow: 'Photos' });
  });
});

describe('pickerQueue', () => {
  it('hands the held picker out once', () => {
    const queue = pickerQueue();
    queue.hold('Photos');
    expect(queue.take()).toBe('Photos');
    expect(queue.take()).toBeNull();
  });
});
