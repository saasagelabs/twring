import { describe, expect, it } from 'vitest';

import { PrivateIdle } from './private-idle';

describe('PrivateIdle', () => {
  it('reports a turn silent for longer than the limit once, then forgets it', () => {
    let t = 0;
    const idle = new PrivateIdle(60_000, () => t);
    idle.touch('msg_a', 'u1', 'agt_1');
    t = 60_000;
    expect(idle.stale()).toEqual([]);
    t = 60_001;
    expect(idle.stale()).toEqual([{ turnId: 'msg_a', userId: 'u1', agentId: 'agt_1' }]);
    expect(idle.stale()).toEqual([]);
  });

  it('a touch moves the clock, end forgets, and the map is capped', () => {
    let t = 0;
    const idle = new PrivateIdle(10, () => t, 2);
    idle.touch('a', 'u', 'g');
    idle.touch('b', 'u', 'g');
    idle.touch('c', 'u', 'g');
    t = 11;
    expect(idle.stale().map((s) => s.turnId)).toEqual(['b', 'c']);
    idle.touch('d', 'u', 'g');
    idle.end('d');
    t = 30;
    expect(idle.stale()).toEqual([]);
  });
});
