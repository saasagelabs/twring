import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { feedbackHint, sendFeedback } from './send';

describe('sendFeedback', () => {
  it('sends the trimmed note', async () => {
    const api = { sendAppFeedback: vi.fn(() => Promise.resolve()) };
    await expect(sendFeedback(api, '  The ring was quiet.  ')).resolves.toEqual({ ok: true });
    expect(api.sendAppFeedback).toHaveBeenCalledWith('The ring was quiet.');
  });

  it('asks for words first, and refuses a note over 1000 characters, without a request', async () => {
    const api = { sendAppFeedback: vi.fn(() => Promise.resolve()) };
    await expect(sendFeedback(api, '   ')).resolves.toEqual({
      ok: false,
      message: 'Write a few words first.',
    });
    await expect(sendFeedback(api, 'x'.repeat(1001))).resolves.toMatchObject({ ok: false });
    expect(api.sendAppFeedback).not.toHaveBeenCalled();
  });

  it('says plainly when sending failed or was too soon', async () => {
    const busy = { sendAppFeedback: () => Promise.reject(new ApiError('http', 'rate_limited')) };
    await expect(sendFeedback(busy, 'hi')).resolves.toEqual({
      ok: false,
      message: 'Thanks! You can send more in a little while.',
    });
    const down = { sendAppFeedback: () => Promise.reject(new ApiError('network')) };
    await expect(sendFeedback(down, 'hi')).resolves.toEqual({
      ok: false,
      message: "Couldn't send it. Check your connection and try again.",
    });
  });
});

describe('feedbackHint', () => {
  it('says who may get a reply', () => {
    expect(feedbackHint('ann@example.com')).toBe(
      'We read every note and may reply to ann@example.com.',
    );
    expect(feedbackHint(undefined)).toBe('We read every note.');
  });
});
