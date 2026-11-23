import { describe, expect, it } from 'vitest';

import type { AgentRecord } from '../store/repositories';

import { accountWords } from './words';

const agent = (keyterms?: string[]) => ({ keyterms }) as unknown as AgentRecord;

describe('accountWords', () => {
  it('unions every agent’s words once each, any case, first seen first', () => {
    expect(
      accountWords([agent(['SaaSage', 'Rishflips']), agent(), agent(['saasage', 'Claude'])]),
    ).toEqual(['SaaSage', 'Rishflips', 'Claude']);
    expect(accountWords([])).toEqual([]);
  });
});
