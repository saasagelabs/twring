import { SEALED_CHAT_FEATURE, type Agent } from '@twring/contracts';

import { ApiError } from '../api/client';
import { apiErrorCopy } from '../api/errors';
import type { TrustedDevice } from './pairing';

/**
 * Turning private chats on for one computer agent (ADR-044, opt-in per agent). Only an agent on
 * the person's own computer can be private, never an AI app connected online, and only while the
 * server offers it (`sealed_chat`, behind PRIVATE_CHATS_ENABLED).
 */

export const PRIVATE_ROW_LABEL = 'Make chats private';
export const UPDATE_COMPUTER = 'Update Twring on your computer first, then try again.';
/** Shown in a private chat that has no paired computer to send to (P3b ruling 3). */
export const PAIR_AGAIN = 'Pair your computer again';

export function showPrivateRow(input: {
  features: readonly string[];
  agent: Pick<Agent, 'protocol'>;
}): boolean {
  return input.features.includes(SEALED_CHAT_FEATURE) && input.agent.protocol === 'cord-connector';
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
