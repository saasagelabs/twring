import {
  AUDIO_EXPIRED_MESSAGE,
  AUDIO_LIMIT_REACHED_MESSAGE,
  AUDIO_PAUSED_MESSAGE,
  AUDIO_UNAVAILABLE_MESSAGE,
  AUDIO_UNREACHABLE_MESSAGE,
  FILE_QUOTA_BYTES,
  type SpeechProvider,
} from '@twring/contracts';

import { COMPUTER_OFFLINE_MESSAGE, COMPUTER_REMOVED_MESSAGE } from '../agents/labels';
import { providerLabel } from '../settings/voice-accounts';
import { dailyLimitMessage, serviceBusyMessage } from '../usage/copy';

import { ApiError } from './client';

/** What went wrong and what to do next (UX_UI_SPEC §19). `detail` is the optional technical line. */
export interface ErrorCopy {
  message: string;
  detail?: string;
  /** True when trying the same thing again may work. */
  retryable: boolean;
}

function detailOf(error: ApiError): string | undefined {
  const parts = [error.code, error.requestId && `ref ${error.requestId}`].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** A computer agent whose computer is not connected; shown before a call, or after one fails. */
export const AGENT_OFFLINE_COPY: ErrorCopy = { message: COMPUTER_OFFLINE_MESSAGE, retryable: true };

/**
 * User copy for any failure from the Twring API. Never shows raw codes as the message; server text
 * is shown only for the `speech_key_*` codes (it names the provider), capped at 200 characters.
 * `provider`, when the caller knows which voice account the request was about, lets the fallback
 * name it if the server sent no sentence of its own.
 */
export function apiErrorCopy(
  error: unknown,
  context: { provider?: SpeechProvider } = {},
): ErrorCopy {
  const providerName = context.provider === undefined ? undefined : providerLabel(context.provider);
  if (!(error instanceof ApiError)) {
    return { message: 'Something went wrong. Try again.', retryable: true };
  }
  const detail = detailOf(error);
  // An empty sentence from the server counts as none.
  const serverMessage = error.serverMessage === '' ? undefined : error.serverMessage;
  const withDetail = (copy: ErrorCopy): ErrorCopy =>
    detail === undefined ? copy : { ...copy, detail };
  switch (error.kind) {
    case 'network':
      return {
        message: "Twring couldn't reach its server. Check your internet connection and try again.",
        retryable: true,
      };
    case 'timeout':
      return { message: 'The server took too long to answer. Try again.', retryable: true };
    case 'cancelled':
      return { message: 'The request was cancelled.', retryable: true };
    case 'invalid_response':
      return withDetail({
        message: 'Twring got an unexpected reply from its server. Try again, or update the app.',
        retryable: true,
      });
    case 'http':
      break;
  }
  switch (error.code) {
    case 'not_supported':
      return withDetail({
        message: 'Only agents on your computer can start a new conversation.',
        retryable: false,
      });
    case 'thread_queue_full':
      return withDetail({
        message: 'Your agent already has 5 messages waiting. Wait for them to go through.',
        retryable: true,
      });
    case 'service_unavailable':
      return withDetail({
        message:
          "Saved agents aren't turned on for this Twring server yet. Ask whoever runs it to set them up.",
        retryable: true,
      });
    case 'rate_limited':
      return withDetail({
        message: 'Too many changes in a short time. Wait a minute and try again.',
        retryable: true,
      });
    case 'not_found':
      return withDetail({
        message: 'This agent no longer exists. Go back to your agents.',
        retryable: false,
      });
    case 'endpoint_rejected':
      return withDetail({
        message:
          "Twring can't connect to that address. Use a public address that starts with https:// or wss://.",
        retryable: false,
      });
    case 'endpoint_unresolvable':
      return withDetail({
        message: "We couldn't look up that address. Check it and try again.",
        retryable: true,
      });
    case 'credential_unreadable':
      return withDetail({
        message: "The saved key can't be read anymore. Enter it again under Connection.",
        retryable: false,
      });
    case 'agent_tests_disabled':
      return withDetail({
        message:
          'Connection tests are paused on the Twring server right now. Your agent is saved; test it again later.',
        retryable: true,
      });
    case 'voice_samples_disabled':
      return withDetail({
        message: 'Voice previews are paused right now. You can still choose a voice.',
        retryable: true,
      });
    case 'auth_required':
      return withDetail({
        message: 'You are signed out. Sign in again to continue.',
        retryable: false,
      });
    case 'auth_invalid':
      // Only seen while still signed in: the session could not be renewed just now (offline). A
      // session that really ended goes straight to Sign in with its own notice.
      return withDetail({
        message:
          "Twring couldn't renew your sign-in. Check your internet connection and try again.",
        retryable: true,
      });
    case 'auth_unavailable':
      return withDetail({
        message: "Twring couldn't check your sign-in just now. Try again in a moment.",
        retryable: true,
      });
    case 'not_invited':
      return withDetail({
        message:
          "This Google account isn't in the Twring beta yet. Sign in with the account your invite went to, or join the waitlist at twring.com.",
        retryable: false,
      });
    case 'invite_invalid':
      return withDetail({
        message: "That code isn't valid. Check it, or ask for a new one.",
        retryable: false,
      });
    case 'daily_limit_reached':
      return withDetail({ message: dailyLimitMessage(error.resetsAt), retryable: false });
    case 'service_busy':
      return withDetail({ message: serviceBusyMessage(error.resetsAt), retryable: false });
    case 'pairing_invalid':
      return withDetail({
        message: 'That code is wrong, used, or expired. Get a new code and try again.',
        retryable: true,
      });
    case 'pairing_other_account':
      // Only the connector sees this one (ADR-027 re-link); the phone never claims codes.
      return withDetail({
        message: 'That computer is linked to another Twring account.',
        retryable: false,
      });
    case 'connector_invalid':
      return withDetail({
        message: COMPUTER_REMOVED_MESSAGE,
        retryable: false,
      });
    case 'call_in_progress':
      return withDetail({ message: "You're already on a call. End it first.", retryable: true });
    case 'approval_already_decided':
      return withDetail({ message: 'This approval was already decided.', retryable: false });
    case 'file_too_large':
      return withDetail({
        message: 'That file is over 10 MB. Send a smaller one.',
        retryable: false,
      });
    case 'unsupported_file_type':
      return withDetail({
        message: 'Twring can send photos, PDFs and text files. This file is another type.',
        retryable: false,
      });
    case 'storage_full':
      return withDetail({
        message: `Your ${FILE_QUOTA_BYTES / 1024 ** 2} MB of files is full. Clear a chat to free space.`,
        retryable: false,
      });
    case 'files_daily_limit':
      return withDetail({
        message: "You've sent 100 files today. You can send more tomorrow.",
        retryable: false,
      });
    case 'speech_keys_disabled':
      return withDetail({
        message: 'Your own voice accounts are not turned on yet. Try again later.',
        retryable: false,
      });
    case 'speech_key_invalid':
      return withDetail({
        message: serverMessage ?? "That doesn't look like a key. Paste it again.",
        retryable: false,
      });
    // The server's sentence names the provider, which the code does not.
    case 'speech_key_refused':
      return withDetail({
        message:
          serverMessage ??
          (providerName === undefined
            ? 'Your voice account key was refused. Update it in Settings.'
            : `${providerName} refused this key. Check it in your ${providerName} account.`),
        retryable: false,
      });
    case 'speech_key_check_failed':
      return withDetail({
        message:
          serverMessage ??
          `Couldn't reach ${providerName ?? 'the voice account'} to check the key. Try again.`,
        retryable: true,
      });
    case 'speech_key_unreadable':
      return withDetail({
        message:
          serverMessage ??
          `Couldn't read your saved ${providerName ?? 'voice account'} key. Add it again in Settings.`,
        retryable: false,
      });
    case 'device_removed':
      return withDetail({
        message: 'This phone was removed from the server. Ask an admin for a new code.',
        retryable: false,
      });
    case 'forbidden':
      return withDetail({ message: 'Only an admin on this server can do that.', retryable: false });
    case 'last_admin':
      return withDetail({
        message: "A server needs at least one admin, so this person can't be removed.",
        retryable: false,
      });
    case 'relay_handle_taken':
      return withDetail({
        message: "This phone couldn't be set up for calls. Close Twring and open it again.",
        retryable: true,
      });
    case 'audio_unavailable':
      return withDetail({ message: AUDIO_UNAVAILABLE_MESSAGE, retryable: true });
    case 'audio_unreachable':
      return withDetail({ message: AUDIO_UNREACHABLE_MESSAGE, retryable: false });
    case 'audio_paused':
      return withDetail({ message: AUDIO_PAUSED_MESSAGE, retryable: false });
    case 'audio_expired':
      return withDetail({ message: AUDIO_EXPIRED_MESSAGE, retryable: false });
    case 'audio_limit_reached':
      return withDetail({ message: AUDIO_LIMIT_REACHED_MESSAGE, retryable: true });
    // Relay to installer only; never reaches the app in practice.
    case 'relay_misconfigured':
      return withDetail({
        message: "Twring's service is having trouble right now. Try again later.",
        retryable: true,
      });
    case 'computer_link_outdated':
      return withDetail({
        message:
          "This agent's computer link needs an update. Ask your admin to run the Twring update on that computer.",
        retryable: false,
      });
    case 'agent_offline':
      return withDetail(AGENT_OFFLINE_COPY);
    case 'agent_not_on_computer':
      return withDetail({
        message: "This agent isn't set up on your computer anymore.",
        retryable: false,
      });
    case 'invite_expired':
      return withDetail({ message: 'This call already stopped ringing.', retryable: false });
    case 'invite_already_handled':
      return withDetail({
        message: 'This call was already answered or declined.',
        retryable: false,
      });
    // Codes only the connector (ADR-024) or the landing page's waitlist sees; listed so this
    // switch stays exhaustive.
    case 'agent_not_saved':
    case 'owner_unavailable':
    case 'owner_busy':
    case 'no_ring_phone':
    case 'ring_pending':
    case 'ring_rate_limited':
    case 'invalid_email':
    case 'apple_revoke_failed':
      return withDetail({
        message: "Apple didn't confirm in time. Try again later.",
        retryable: true,
      });
    case 'origin_not_allowed':
    case 'waitlist_full':
    case 'bad_request':
    case 'invalid_request':
      return withDetail({
        message: "Some of the details aren't valid. Check them and try again.",
        retryable: false,
      });
    case 'not_ready':
    case 'capacity_exceeded':
    case 'internal_error':
    case undefined:
      return withDetail({
        message: 'Something went wrong on the Twring server. Try again in a moment.',
        retryable: true,
      });
  }
}

/** True when the failure means saved agents are not configured on the server at all. */
export function isServiceUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'service_unavailable';
}
