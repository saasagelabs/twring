import { describe, expect, it } from 'vitest';

import { greeting } from './greeting';

const at = (hour: number) => new Date(2026, 9, 8, hour);

describe('greeting', () => {
  it.each([
    [4, 'GOOD EVENING'],
    [5, 'GOOD MORNING'],
    [11, 'GOOD MORNING'],
    [12, 'GOOD AFTERNOON'],
    [16, 'GOOD AFTERNOON'],
    [17, 'GOOD EVENING'],
  ])('uses the right greeting at %i:00', (hour, expected) => {
    expect(greeting(at(hour))).toBe(expected);
  });

  it('uses the first, uppercased word of a trimmed name', () => {
    expect(greeting(at(9), '  Alex Smith ')).toBe('GOOD MORNING, ALEX');
  });

  it('drops a long name when the complete greeting exceeds 24 characters', () => {
    expect(greeting(at(12), 'Alexanderthegreat Smith')).toBe('GOOD AFTERNOON');
  });
});
