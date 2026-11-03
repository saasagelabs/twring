import { describe, expect, it } from 'vitest';

import { downlinkWindow } from './downlink';

describe('downlinkWindow', () => {
  it('reports per-window bytes, loss, jitter, and played level', () => {
    const window = downlinkWindow(
      {
        at: 0,
        bytesReceived: 100,
        packetsLost: 1,
        totalAudioEnergy: 0.5,
        totalSamplesDuration: 10,
      },
      // 5 s more audio with energy 0.05 → mean power 0.01 → -20 dBFS.
      {
        at: 5000,
        bytesReceived: 350,
        packetsLost: 3,
        jitter: 0.012,
        totalAudioEnergy: 0.55,
        totalSamplesDuration: 15,
      },
    );
    expect(window).toEqual({
      window_ms: 5000,
      bytes_received: 250,
      packets_lost: 2,
      jitter_ms: 12,
      level_dbfs: -20,
    });
  });

  it('treats silence and missing counters as the floor, never NaN', () => {
    expect(downlinkWindow({ at: 0 }, { at: 5000 })).toEqual({
      window_ms: 5000,
      bytes_received: 0,
      packets_lost: 0,
      jitter_ms: 0,
      level_dbfs: -120,
    });
  });

  it('never reports negative deltas when counters reset', () => {
    const window = downlinkWindow(
      { at: 0, bytesReceived: 500, totalAudioEnergy: 1, totalSamplesDuration: 20 },
      { at: 5000, bytesReceived: 10, totalAudioEnergy: 0.1, totalSamplesDuration: 1 },
    );
    expect(window.bytes_received).toBe(0);
    expect(window.level_dbfs).toBe(-120);
  });
});
