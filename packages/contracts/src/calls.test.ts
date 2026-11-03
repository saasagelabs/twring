import { describe, expect, it } from 'vitest';

import {
  callFeedbackRequestSchema,
  createCallRequestSchema,
  createCallResponseSchema,
} from './calls';

describe('call feedback contract', () => {
  it('defaults issues, trims notes, and rejects invalid ratings and issues', () => {
    expect(callFeedbackRequestSchema.parse({ rating: 5, note: ' thanks ' })).toEqual({
      rating: 5,
      issues: [],
      note: 'thanks',
    });
    for (const body of [{ rating: 0 }, { rating: 6 }, { rating: 2, issues: ['slow', 'slow'] }])
      expect(callFeedbackRequestSchema.safeParse(body).success).toBe(false);
    // Only the caller knows if they were misheard: issues are allowed with any rating.
    expect(callFeedbackRequestSchema.parse({ rating: 5, issues: ['misheard'] }).issues).toEqual([
      'misheard',
    ]);
  });
});

const response = {
  call_id: 'call_abcdefghij0123456789',
  session_id: 'sess_abcdefghij0123456789',
  livekit: { url: 'wss://cord-staging.livekit.cloud', token: 'jwt', room: 'cord-call-x' },
  expires_at: '2026-09-25T10:00:00.000Z',
};

describe('call contracts', () => {
  it('accepts a create-call response', () => {
    expect(createCallResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects a non-WebSocket LiveKit URL', () => {
    const result = createCallResponseSchema.safeParse({
      ...response,
      livekit: { ...response.livekit, url: 'https://cord-staging.livekit.cloud' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed call IDs', () => {
    expect(createCallResponseSchema.safeParse({ ...response, call_id: 'call_1' }).success).toBe(
      false,
    );
  });

  it('rejects unexpected request fields such as a client-supplied user ID', () => {
    expect(createCallRequestSchema.safeParse({ user_id: 'u1' }).success).toBe(false);
  });
});
