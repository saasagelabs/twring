import type { Agent, ThreadMessage } from '@twring/contracts';

import { ApiError } from '../api/client';
import { apiErrorCopy } from '../api/errors';
import { hasComputerFor } from './devices';
import type { TrustedDevice } from './pairing';
import type { SealedFileEntry } from './sealed-files';
import { aadIdsFor, type OpenedMessage } from './sealed-thread';
import { clearVoiceConsent } from './voice-consent';
import type { SecureKeyValue } from '../auth/storage';

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

/** The agent's address names no computer (not a connector endpoint). */
export const NO_COMPUTER =
  'Twring could not find the computer this agent runs on. Try again later.';

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

/**
 * With no paired computer for this agent's connector, pairing comes first; it returns here
 * (`?agentId=`) to finish. A computer paired for another connector does not count.
 */
export async function turnOnPrivate(deps: {
  agentId: string;
  /** The agent's address; its connector id names the computer it runs on. */
  endpointUrl: string;
  trusted: readonly TrustedDevice[];
  nav: { push(to: string): unknown };
  api: { setPrivate(agentId: string): Promise<void> };
  /** The private keychain: a chat made private anew asks again before voice notes. */
  consent?: SecureKeyValue;
}): Promise<TurnOnResult> {
  const ids = aadIdsFor(deps.endpointUrl);
  if (ids === undefined) return { status: 'failed', message: NO_COMPUTER };
  if (!hasComputerFor(deps.trusted, ids.accountId)) {
    deps.nav.push(`/private/pair?agentId=${encodeURIComponent(deps.agentId)}`);
    return { status: 'pair' };
  }
  try {
    await deps.api.setPrivate(deps.agentId);
    if (deps.consent !== undefined)
      await clearVoiceConsent(deps.consent, deps.agentId).catch(() => undefined);
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
/** Before the first voice note in a private chat, asked once per chat on this phone. */
export const VOICE_CONSENT_ASK =
  "Voice notes are turned into text on Twring's server, so they won't be private. Use voice notes in this chat?";
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
 * `readableMessages` is the server's word for the whole chat, so older messages not loaded yet
 * count too; an older server leaves it out and the loaded messages decide.
 */
export function labelFor(input: {
  private: boolean;
  messages: readonly ThreadMessage[];
  readableMessages?: boolean;
}): { text: string } | undefined {
  if (!input.private) return undefined;
  const readable = input.readableMessages === true || input.messages.some(serverReadable);
  return { text: readable ? PRIVATE_LABEL_EXCEPT : PRIVATE_LABEL };
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

/** A message this phone sent after another phone removed it: the computer never read it. */
export const NOT_DELIVERED = 'Not delivered';

/**
 * This phone's own private messages with no reply after them, once another phone removed it. A
 * reply sealed without this phone (the computer's "could not open") is not an answer. Only
 * messages sent at or after `removedAt` count: earlier ones reached the computer. With no removal
 * time nothing is marked, rather than a false "Not delivered".
 */
export function undeliveredIds(
  messages: readonly ThreadMessage[],
  sealedToMe: (message: Extract<ThreadMessage, { kind: 'sealed' }>) => boolean,
  removedAt: string | undefined,
): Set<string> {
  const ids = new Set<string>();
  const since = removedAt === undefined ? NaN : Date.parse(removedAt);
  if (Number.isNaN(since)) return ids;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind !== 'sealed') {
      if (message.kind === 'agent_text') break;
      continue;
    }
    if (message.author === 'user') {
      if (Date.parse(message.created_at) >= since) ids.add(message.id);
    } else if (sealedToMe(message)) break;
  }
  return ids;
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
