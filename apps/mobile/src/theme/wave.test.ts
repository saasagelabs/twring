import { describe, expect, it } from 'vitest';

import { wavePath, type WavePathOptions } from './wave';

const options: WavePathOptions = {
  width: 300,
  height: 110,
  time: 1.2,
  intensity: 1,
  phase: 0.7,
  ampMul: 1,
  freqMul: 1,
};

describe('wavePath', () => {
  it('is flat at zero intensity', () => {
    const path = wavePath({ ...options, intensity: 0 });
    const numbers = path.match(/-?\d+\.\d/g)?.map(Number) ?? [];
    expect(numbers.filter((_, index) => index % 2 === 1).every((y) => y === 55)).toBe(true);
  });

  it('starts at x zero and ends at the requested width', () => {
    const path = wavePath(options);
    expect(path).toMatch(/^M 0\.0 /);
    expect(path).toMatch(/ T 300\.0 -?\d+\.\d$/);
  });

  it('keeps full-intensity points within the viewBox', () => {
    const numbers =
      wavePath(options)
        .match(/-?\d+\.\d/g)
        ?.map(Number) ?? [];
    const ys = numbers.filter((_, index) => index % 2 === 1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(options.height);
  });

  it('is deterministic', () => {
    expect(wavePath(options)).toBe(wavePath({ ...options }));
  });
});
