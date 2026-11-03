import { FILE_QUOTA_BYTES, type ErrorCode } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError } from './client';
import { apiErrorCopy } from './errors';

describe('apiErrorCopy', () => {
  it('asks for the admin to update an outdated computer link', () => {
    const copy = apiErrorCopy(
      new ApiError('http', 'computer_link_outdated', 'req-1', undefined, 409),
    );
    expect(copy).toMatchObject({
      message:
        "This agent's computer link needs an update. Ask your admin to run the Twring update on that computer.",
      retryable: false,
    });
  });

  it('names the real file storage size when storage is full', () => {
    expect(FILE_QUOTA_BYTES).toBe(100 * 1024 * 1024);
    const copy = apiErrorCopy(new ApiError('http', 'storage_full', 'req-1', undefined, 507));
    expect(copy.message).toBe('Your 100 MB of files is full. Clear a chat to free space.');
  });

  describe('your own voice accounts', () => {
    const http = (code: ErrorCode, message?: string) =>
      new ApiError('http', code, 'req-1', undefined, 400, undefined, message);

    it('says the feature is off', () => {
      expect(apiErrorCopy(http('speech_keys_disabled')).message).toBe(
        'Your own voice accounts are not turned on yet. Try again later.',
      );
    });

    it('uses the server message for save errors that name the provider', () => {
      expect(
        apiErrorCopy(http('speech_key_invalid', "That doesn't look like a key. Paste it again."))
          .message,
      ).toBe("That doesn't look like a key. Paste it again.");
      expect(
        apiErrorCopy(
          http(
            'speech_key_refused',
            'Deepgram refused this key. Check it in your Deepgram account.',
          ),
        ).message,
      ).toBe('Deepgram refused this key. Check it in your Deepgram account.');
      expect(
        apiErrorCopy(
          http('speech_key_check_failed', "Couldn't reach Cartesia to check the key. Try again."),
        ),
      ).toMatchObject({
        message: "Couldn't reach Cartesia to check the key. Try again.",
        retryable: true,
      });
    });

    it('falls back to generic copy without a server message', () => {
      expect(apiErrorCopy(http('speech_key_invalid')).message).toBe(
        "That doesn't look like a key. Paste it again.",
      );
      expect(apiErrorCopy(http('speech_key_refused')).message).toBe(
        'Your voice account key was refused. Update it in Settings.',
      );
      expect(apiErrorCopy(http('speech_key_unreadable')).message).toBe(
        "Couldn't read your saved voice account key. Add it again in Settings.",
      );
      expect(apiErrorCopy(http('speech_key_check_failed')).message).toBe(
        "Couldn't reach the voice account to check the key. Try again.",
      );
    });

    it('names the provider in the fallback when it is known', () => {
      expect(apiErrorCopy(http('speech_key_refused'), { provider: 'xai' }).message).toBe(
        'xAI refused this key. Check it in your xAI account.',
      );
      expect(apiErrorCopy(http('speech_key_check_failed'), { provider: 'cartesia' }).message).toBe(
        "Couldn't reach Cartesia to check the key. Try again.",
      );
      expect(apiErrorCopy(http('speech_key_unreadable'), { provider: 'deepgram' }).message).toBe(
        "Couldn't read your saved Deepgram key. Add it again in Settings.",
      );
      expect(
        apiErrorCopy(http('speech_key_refused', 'Server words.'), { provider: 'xai' }).message,
      ).toBe('Server words.');
    });

    it('prefers the server message for refused and unreadable keys elsewhere', () => {
      expect(
        apiErrorCopy(
          http('speech_key_refused', 'Your Deepgram key was refused. Update it in Settings.'),
        ).message,
      ).toBe('Your Deepgram key was refused. Update it in Settings.');
      expect(
        apiErrorCopy(
          http(
            'speech_key_unreadable',
            "Couldn't read your saved Cartesia key. Add it again in Settings.",
          ),
        ).message,
      ).toBe("Couldn't read your saved Cartesia key. Add it again in Settings.");
    });
  });
});
