import { MAX_APP_FEEDBACK_CHARS } from '@twring/contracts';

import { ApiError } from '../api/client';

/** What the Settings feedback screen needs from the API. */
export interface FeedbackApi {
  sendAppFeedback(note: string): Promise<void>;
}

export type SendResult = { ok: true } | { ok: false; message: string };

/** Sends a note from Settings, with the same rules the server enforces, in plain words. */
export async function sendFeedback(api: FeedbackApi, note: string): Promise<SendResult> {
  const text = note.trim();
  if (text === '') return { ok: false, message: 'Write a few words first.' };
  if (text.length > MAX_APP_FEEDBACK_CHARS) {
    return { ok: false, message: `Keep it under ${MAX_APP_FEEDBACK_CHARS} characters.` };
  }
  try {
    await api.sendAppFeedback(text);
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'rate_limited') {
      return { ok: false, message: 'Thanks! You can send more in a little while.' };
    }
    return { ok: false, message: "Couldn't send it. Check your connection and try again." };
  }
}

/** Who may get an answer: the account's email when there is one. */
export function feedbackHint(email: string | undefined): string {
  return email ? `We read every note and may reply to ${email}.` : 'We read every note.';
}
