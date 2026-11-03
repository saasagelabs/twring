import { z } from 'zod';

/**
 * Stable machine-readable error codes. Clients branch on `code`, never on `message`.
 * Add codes as features land; never repurpose an existing code.
 */
export const errorCodeSchema = z.enum([
  'bad_request',
  'invalid_request',
  'not_supported',
  'not_found',
  'not_ready',
  'rate_limited',
  'capacity_exceeded',
  'service_unavailable',
  'internal_error',
  /** An agent endpoint failed the SSRF/TLS guard (private, reserved, or plain-text address). */
  'endpoint_rejected',
  /** An agent endpoint's host name could not be looked up (no answer in time, or no such host). */
  'endpoint_unresolvable',
  /** A saved agent credential can no longer be decrypted; the user must enter it again. */
  'credential_unreadable',
  /** Kill switch: outbound agent connection tests are turned off (`AGENT_TESTS_ENABLED=false`). */
  'agent_tests_disabled',
  /** Kill switch: voice previews are turned off (`VOICE_SAMPLES_ENABLED=false`). */
  'voice_samples_disabled',
  /** No bearer token on a request that needs a signed-in user (401). */
  'auth_required',
  /** The access token is expired, malformed, or not from this Twring's Supabase project (401). */
  'auth_invalid',
  /** The sign-in keys could not be fetched, so no token can be checked right now (503). */
  'auth_unavailable',
  /** The signed-in Google account is not in this server's invite-only beta (403). */
  'not_invited',
  'invite_invalid',
  /** The user's calling allowance for this UTC day is used up; `resets_at` says when it renews. */
  'daily_limit_reached',
  /** A connector pairing code is wrong, used, or expired (ADR-023). */
  'pairing_invalid',
  /** A pairing code from one account was claimed by a computer linked to another (403, ADR-027). */
  'pairing_other_account',
  /** A connector token is unknown or revoked (ADR-023). */
  'connector_invalid',
  /**
   * The user already has a live call (created, connecting, or connected). One call at a time,
   * like a phone line (409).
   */
  'call_in_progress',
  'approval_already_decided',
  /** A file is over 10 MB (413). */
  'file_too_large',
  /** A file's bytes are not one of the stored types (415). */
  'unsupported_file_type',
  /** The person's stored files fill their quota (507, FILE_QUOTA_BYTES); deleting chats frees it. */
  'storage_full',
  /** The person's 100 new files for this UTC day are used up (429). */
  'files_daily_limit',
  /** A `cord-connector` agent's computer is not connected right now; nothing was counted (409). */
  'agent_offline',
  /** The user's computer no longer offers this agent (its latest hello left it out) (409). */
  'agent_not_on_computer',
  /** A ring named a local agent the user has not saved as a Twring agent (ADR-024) (404). */
  'agent_not_saved',
  /** The owner has Do Not Disturb or quiet hours on; the ring was not placed (409). */
  'owner_unavailable',
  /** The owner is already in a call (409). */
  'owner_busy',
  /** The owner has no phone that can ring yet (no Android phone with Twring signed in) (409). */
  'no_ring_phone',
  /** An invite is already ringing for this owner (409). */
  'ring_pending',
  /** More than the allowed rings per agent per hour (409). */
  'ring_rate_limited',
  /** A thread already has five messages waiting for its agent. */
  'thread_queue_full',
  /** The invite stopped ringing before it was answered (410). */
  'invite_expired',
  /** The invite was already answered, declined, missed, or cancelled (409). */
  'invite_already_handled',
  /** The beta waitlist got something that is not an email address (400). */
  'invalid_email',
  /** A browser on a site other than the landing page called the waitlist (403). */
  'origin_not_allowed',
  /** The beta waitlist is at its cap; new emails are refused (503). */
  'waitlist_full',
  /** Apple did not confirm ending Sign in with Apple for a deleted account (502). */
  'apple_revoke_failed',
  /** Today's calling for the whole service is used up; `resets_at` says when it renews (503). */
  'service_busy',
  /** Own speech keys are not switched on for this server (404). */
  'speech_keys_disabled',
  /** The pasted key is not shaped like a key (400). */
  'speech_key_invalid',
  /** The voice account refused the key: 422 when it is saved, 409 when a saved key is in use. */
  'speech_key_refused',
  /**
   * The voice account could not be reached to check the key (503), or the save overlapped Delete
   * my data (409). Try again.
   */
  'speech_key_check_failed',
  /** A saved key can no longer be read, so it must be added again (409). */
  'speech_key_unreadable',
  /** Self-hosted: this phone (or its person) was removed from the server, or is unknown (401). */
  'device_removed',
  /** Self-hosted: only an admin on the server may do this (403). */
  'forbidden',
  /** Self-hosted: the last admin of a server cannot be removed (409). */
  'last_admin',
  'relay_handle_taken',
  /**
   * Self-hosted: the computer a shared agent runs on has an older link that cannot keep a separate
   * conversation per person, so others cannot call or message it until it is updated (409).
   */
  'computer_link_outdated',
  /** Self-hosted, Twring-run call audio: Twring's audio service could not be reached (503). */
  'audio_unavailable',
  /** Self-hosted, own call audio: the server's own call audio could not be reached (503). */
  'audio_unreachable',
  /** Self-hosted, Twring-run call audio: paused until the server's email is confirmed (403). */
  'audio_paused',
  /** Self-hosted, Twring-run call audio: the server's service has ended (403). */
  'audio_expired',
  /** Self-hosted, Twring-run call audio: daily minutes or calls at once used up (429). */
  'audio_limit_reached',
  /** Relay: it sees a non-public caller address, so its proxy setting is wrong (503). */
  'relay_misconfigured',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Wire shape for every Twring HTTP error response. `message` must be safe to show a user. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    request_id: z.string().optional(),
    /** With `daily_limit_reached`: when the allowance renews (next UTC midnight, ISO 8601). */
    resets_at: z.iso.datetime().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
