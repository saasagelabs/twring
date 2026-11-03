import { describe, expect, it } from 'vitest';

import { MAX_STATUS_MESSAGE_BYTES, parseStatusMessage, type AudioStatsMessage } from './realtime';
import { agentEventSchema } from './agent';

it('accepts optional new session marker on run.started', () => {
  const started = { type: 'run.started', event_id: 'event', turn_id: 'turn' };
  expect(agentEventSchema.parse(started)).toEqual(started);
  expect(agentEventSchema.parse({ ...started, new_session: true })).toEqual({
    ...started,
    new_session: true,
  });
  expect(agentEventSchema.parse({ ...started, future_key: true })).toEqual(started);
  expect(agentEventSchema.safeParse({ ...started, new_session: false }).success).toBe(false);
});

const stats: AudioStatsMessage = {
  v: 1,
  type: 'audio_stats',
  call_id: 'call_aaaaaaaaaaaaaaaaaaaa',
  window_ms: 1000,
  frames_received: 50,
  peak_dbfs: -23.5,
};

describe('parseStatusMessage', () => {
  it('round-trips a valid audio_stats message', () => {
    expect(parseStatusMessage(JSON.stringify(stats))).toEqual(stats);
  });

  it.each([
    ['malformed JSON', '{"v":1,'],
    ['unknown type', JSON.stringify({ ...stats, type: 'agent_said' })],
    ['unknown version', JSON.stringify({ ...stats, v: 2 })],
    ['positive dBFS', JSON.stringify({ ...stats, peak_dbfs: 3 })],
    ['negative frame count', JSON.stringify({ ...stats, frames_received: -1 })],
    ['oversized payload', JSON.stringify({ ...stats, pad: 'x'.repeat(MAX_STATUS_MESSAGE_BYTES) })],
  ])('drops %s', (_label, text) => {
    expect(parseStatusMessage(text)).toBeUndefined();
  });

  it('accepts captions, floor, agent text, and notices', () => {
    const caption = {
      v: 1,
      type: 'caption',
      call_id: 'c',
      turn_index: 2,
      text: 'Hi there',
      final: true,
    };
    expect(parseStatusMessage(JSON.stringify(caption))).toEqual(caption);
    const floor = {
      v: 1,
      type: 'floor',
      call_id: 'c',
      seq: 3,
      floor: 'agent_working',
      turn_id: 'turn_1',
      activity: 'Searching…',
    };
    expect(parseStatusMessage(JSON.stringify(floor))).toEqual(floor);
    const text = {
      v: 1,
      type: 'agent_text',
      call_id: 'c',
      turn_id: 'turn_1',
      text: 'Hi',
      final: false,
    };
    expect(parseStatusMessage(JSON.stringify(text))).toEqual(text);
    const notice = { v: 1, type: 'notice', call_id: 'c', code: 'agent_timeout' };
    expect(parseStatusMessage(JSON.stringify(notice))).toEqual(notice);
  });

  it('drops an agent floor without the turn it belongs to', () => {
    const floor = { v: 1, type: 'floor', call_id: 'c', seq: 1, floor: 'agent_speaking' };
    expect(parseStatusMessage(JSON.stringify(floor))).toBeUndefined();
    expect(parseStatusMessage(JSON.stringify({ ...floor, floor: 'listening' }))).toEqual({
      ...floor,
      floor: 'listening',
    });
  });

  it('drops captions longer than the display limit', () => {
    const caption = {
      v: 1,
      type: 'caption',
      call_id: 'c',
      turn_index: 0,
      text: 'x'.repeat(1501),
      final: false,
    };
    expect(parseStatusMessage(JSON.stringify(caption))).toBeUndefined();
  });
});
