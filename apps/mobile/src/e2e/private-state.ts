import type { Agent, ThreadMessage } from '@twring/contracts';

import { ApiError } from '../api/client';
import { apiErrorCopy } from '../api/errors';
import type { TrustedDevice } from './pairing';
import type { SealedFileEntry } from './sealed-files';
import type { OpenedMessage } from './sealed-thread';

/**
 * Turning private chats on for one computer agent (ADR-044, opt-in per agent). Only an agent on
 * the person's own computer can be private, never an AI app connected online, and only while the
 * server has it on for this account (PRIVATE_CHATS_ENABLED and its allowlist).
 */

export const PRIVATE_ROW_LABEL = 'Make chats private';
export const UPDATE_COMPUTER = 'Update Twring on your computer first, then try again.';
/** Shown in a private chat that has no paired computer to send to (P3b ruling 3). */
export const PAIR_AGAIN = 'Pair your computer again';

/** `available`: the account's private chats answered "on" (`GET /v1/e2e/devices`). */
export function showPrivateRow(input: {
  available: boolean;
  agent: Pick<Agent, 'protocol'>;
}): boolean {
  return input.available && input.agent.protocol === 'cord-connector';
}

export function hasComputer(trusted: readonly TrustedDevice[]): boolean {
  return trusted.some((device) => device.kind === 'computer');
}

/** A private chat with no computer to send to: the key was replaced, or pairing was lost. */
export function needsPairAgain(isPrivate: boolean, trusted: readonly TrustedDevice[]): boolean {
  return isPrivate && !hasComputer(trusted);
}

export function confirmPrivateCopy(agentName: string): {
  title: string;
  body: string;
  confirm: string;
} {
  return {
    title: `Make chats with ${agentName} private?`,
    body: `New messages with ${agentName} can only be read on your phone and your computer. Older messages stay as they are. This can't be turned off later.`,
    confirm: 'Make private',
  };
}

export type TurnOnResult =
  | { status: 'pair'; message?: undefined }
  | { status: 'on'; message?: undefined }
  | { status: 'failed'; message: string };

/** With no paired computer, pairing comes first; it returns here (`?agentId=`) to finish. */
export async function turnOnPrivate(deps: {
  agentId: string;
  trusted: readonly TrustedDevice[];
  nav: { push(to: string): unknown };
  api: { setPrivate(agentId: string): Promise<void> };
}): Promise<TurnOnResult> {
  if (!hasComputer(deps.trusted)) {
    deps.nav.push(`/private/pair?agentId=${encodeURIComponent(deps.agentId)}`);
    return { status: 'pair' };
  }
  try {
    await deps.api.setPrivate(deps.agentId);
    return { status: 'on' };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'private_unsupported')
      return { status: 'failed', message: UPDATE_COMPUTER };
    return { status: 'failed', message: apiErrorCopy(error).message };
  }
}

/** Shown in a private chat only when it is true (Task 24, word for word from the plan). */
export const PRIVATE_LABEL = 'Private: only your phone and your computer can read this';
export const PRIVATE_LABEL_EXCEPT = 'Private, except messages marked as sent through Twring';
/** Under a message the server could read (a voice note, or one sent before the chat was private). */
export const SERVER_READABLE_MARK = 'Sent through Twring';
export const VOICE_WARNING =
  "Voice notes are turned into text on Twring's server, so this one won't be private. Send it anyway?";
/** Calls and Listen stay; their speech goes through the server. */
export const SPEECH_NOTE = "Speech goes through Twring's server.";
export const COULDNT_OPEN = "Couldn't open this message";
/** Before a message when earlier ones from the computer never arrived (one row per gap). */
export const MISSING_MESSAGE = 'A message from your computer is missing here.';

/** A message with text the server holds: a voice note, an older message, or one that slipped in. */
export function serverReadable(message: ThreadMessage): boolean {
  return message.kind === 'user_text' || message.kind === 'agent_text';
}

/**
 * The header label of a chat, or undefined. Only a private chat gets one (never an AI app), and
 * it claims "only your phone and your computer" only while no message there was server-readable.
 * Calls, rings, approvals and notices are cards, not messages, and do not change it.
 */
export function labelFor(input: {
  private: boolean;
  messages: readonly ThreadMessage[];
}): { text: string } | undefined {
  if (!input.private) return undefined;
  return {
    text: input.messages.some(serverReadable) ? PRIVATE_LABEL_EXCEPT : PRIVATE_LABEL,
  };
}

export interface SealedBubble {
  text: string;
  own: boolean;
  /** False for "Couldn't open this message": no reply, copy or share. */
  opened: boolean;
  quote?: { from: string; text: string };
  /** The message's photos and files, opened by `SealedAttachments`. */
  files?: SealedFileEntry[];
  actions: ('reply' | 'copy' | 'share')[];
}

/**
 * The notice under an own private message the computer may have started but went silent on (the
 * gateway marks it `interrupted`). `draft` is the text to put back in the box, when it opened.
 */
export function interruptedNotice(
  message: ThreadMessage,
  bubble: SealedBubble,
  agentName: string,
): { text: string; draft: string } | undefined {
  if (message.kind !== 'sealed' || !bubble.own || message.status !== 'interrupted')
    return undefined;
  return {
    text: `Interrupted: ${agentName} may have started this. Its answer will appear here if it finishes.`,
    draft: bubble.opened ? bubble.text : '',
  };
}

/** How a private message is drawn; undefined while the keys load (nothing is drawn yet). */
export function sealedBubble(
  message: ThreadMessage,
  opened: ReadonlyMap<string, OpenedMessage> | undefined,
  agentName: string,
): SealedBubble | undefined {
  if (message.kind !== 'sealed' || opened === undefined) return undefined;
  const found = opened.get(message.id);
  const own = message.author === 'user';
  if (found?.state !== 'ok') return { text: COULDNT_OPEN, own, opened: false, actions: [] };
  const files = found.files !== undefined && found.files.length > 0 ? found.files : undefined;
  // A reply stopped before the agent said anything still ends with an empty final part.
  if (!own && found.text.trim() === '' && found.quote === undefined && files === undefined)
    return undefined;
  return {
    text: found.text,
    own,
    opened: true,
    ...(files !== undefined && { files }),
    ...(found.quote !== undefined && {
      quote: { from: found.quote.from === 'agent' ? agentName : 'You', text: found.quote.text },
    }),
    actions: found.text ? ['reply', 'copy', 'share'] : ['reply'],
  };
}
