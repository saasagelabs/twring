import { describe, expect, it } from 'vitest';

import { askSameNumber } from './pair';

const answers = (...given: string[]) => {
  const asked: string[] = [];
  const ask = (question: string) => {
    asked.push(question);
    return Promise.resolve(given.shift() ?? '');
  };
  return { ask, asked };
};

describe('askSameNumber', () => {
  it.each([
    ['y', true],
    [' Yes ', true],
    ['n', false],
    ['NO', false],
  ])('takes %j as %s', async (answer, same) => {
    expect(await askSameNumber(answers(answer).ask)).toBe(same);
  });

  it('asks again after a typo instead of cancelling the pairing', async () => {
    const { ask, asked } = answers('t', '', 'y');
    expect(await askSameNumber(ask)).toBe(true);
    expect(asked).toHaveLength(3);
    expect(asked[1]).toBe('Type y if the numbers match, or n if they do not: ');
  });

  it('gives up as no after five unclear answers', async () => {
    const { ask, asked } = answers('t', 't', 't', 't', 't', 'y');
    expect(await askSameNumber(ask)).toBe(false);
    expect(asked).toHaveLength(5);
  });
});
