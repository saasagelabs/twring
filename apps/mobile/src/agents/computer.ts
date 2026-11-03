import {
  CONNECTOR_CLI_NAME,
  connectorEndpointUrl,
  type Connector,
  type CreateAgentRequest,
  type LocalAgent,
  type PairingResponse,
  type PairingStatusResponse,
} from '@twring/contracts';

import { ApiError, type TwringApi } from '../api/client';
import type { ErrorCopy } from '@/api/errors';

/**
 * "On my computer" (ADR-023) as a pure reducer: pair a computer with `cord-connect`, pick one of
 * the agents it offers, name it, choose a voice. Kept minimal on purpose; a new design is coming.
 */
export type ComputerStep = 'pair' | 'agent' | 'name' | 'voice' | 'ready';

export type PairingPhase =
  | { kind: 'loading' }
  | { kind: 'waiting'; pairing: PairingResponse }
  | { kind: 'expired' }
  | { kind: 'error'; copy: ErrorCopy };

export interface ComputerState {
  step: ComputerStep;
  pairing: PairingPhase;
  connector?: Connector;
  localAgent?: LocalAgent;
  name: string;
  voiceId?: string;
  /** Set once the agent is saved. */
  agentId?: string;
  /** The saved contact's name: a reused contact keeps its own. */
  savedName?: string;
  /** The computer linked again and took over its old contact (chats and history kept). */
  relinked?: boolean;
}

export type ComputerAction =
  | { type: 'PAIRING_STARTED' }
  | { type: 'PAIRING_CREATED'; pairing: PairingResponse }
  | { type: 'PAIRING_FAILED'; copy: ErrorCopy }
  | { type: 'PAIRING_EXPIRED' }
  | { type: 'CLAIMED'; connector: Connector }
  | { type: 'PICK_AGENT'; agent: LocalAgent }
  | { type: 'SET_NAME'; value: string }
  | { type: 'SET_VOICE'; value: string }
  | { type: 'SAVED'; agentId: string; name: string; relinked?: boolean }
  | { type: 'NEXT' }
  | { type: 'BACK' };

export const COMPUTER_STEPS: readonly ComputerStep[] = ['pair', 'agent', 'name', 'voice', 'ready'];

export function createComputerWizard(): ComputerState {
  return { step: 'pair', pairing: { kind: 'loading' }, name: '' };
}

/** The command the user runs on their computer. */
export function connectCommand(code: string, serverUrl: string): string {
  return `npx ${CONNECTOR_CLI_NAME} --code ${code} --server ${serverUrl.replace(/\/+$/, '')}`;
}

/**
 * The pairing with `expires_at` moved onto this phone's clock. The server says how long the code
 * has left (`expires_at - server_time`); counting that from when the answer arrived keeps the
 * countdown right on a phone whose clock is off. Without `server_time`, `expires_at` is used as is.
 */
export function onPhoneClock<T extends { expires_at: string; server_time?: string }>(
  pairing: T,
  receivedAt: number,
): T {
  if (pairing.server_time === undefined) return pairing;
  const remaining = Date.parse(pairing.expires_at) - Date.parse(pairing.server_time);
  if (!Number.isFinite(remaining)) return pairing;
  return { ...pairing, expires_at: new Date(receivedAt + remaining).toISOString() };
}

/**
 * How long past the countdown the phone keeps waiting for the server's word. A claim that lands
 * right at expiry still shows the paired computer: the poll's answer wins over the local clock,
 * and the phone gives up on its own only if the server stays silent this much longer.
 */
export const PAIRING_EXPIRY_GRACE_MS = 15_000;

/** True once the code has run out here and the server has had its grace to answer. */
export function pairingTimedOut(expiresAt: string, now: number): boolean {
  return now >= Date.parse(expiresAt) + PAIRING_EXPIRY_GRACE_MS;
}

/** "9:41" until the code expires; undefined once it has. */
export function timeLeft(expiresAt: string, now: number): string | undefined {
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return undefined;
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function validateComputerStep(state: ComputerState): string | undefined {
  switch (state.step) {
    case 'pair':
      return state.connector === undefined ? 'Run the command on your computer first.' : undefined;
    case 'agent':
      return state.localAgent === undefined ? 'Choose an agent.' : undefined;
    case 'name': {
      const name = state.name.trim();
      if (name === '') return 'Give your agent a name.';
      return name.length > 60 ? 'Use 60 characters or fewer.' : undefined;
    }
    case 'voice':
      return state.voiceId === undefined ? 'Choose a voice.' : undefined;
    case 'ready':
      return undefined;
  }
}

function move(state: ComputerState, delta: 1 | -1): ComputerState {
  const next = COMPUTER_STEPS[COMPUTER_STEPS.indexOf(state.step) + delta];
  return next === undefined ? state : { ...state, step: next };
}

export function computerReducer(state: ComputerState, action: ComputerAction): ComputerState {
  switch (action.type) {
    case 'PAIRING_STARTED':
      return { ...state, pairing: { kind: 'loading' } };
    case 'PAIRING_CREATED':
      return { ...state, pairing: { kind: 'waiting', pairing: action.pairing } };
    case 'PAIRING_FAILED':
      return { ...state, pairing: { kind: 'error', copy: action.copy } };
    case 'PAIRING_EXPIRED':
      return state.connector === undefined ? { ...state, pairing: { kind: 'expired' } } : state;
    case 'CLAIMED': {
      const only = action.connector.agents.length === 1 ? action.connector.agents[0] : undefined;
      return {
        ...state,
        connector: action.connector,
        step: 'agent',
        ...(only !== undefined && { localAgent: only, name: only.label }),
      };
    }
    case 'PICK_AGENT':
      return {
        ...state,
        localAgent: action.agent,
        // Suggest the agent's own name until the user types one.
        name:
          state.name === '' || state.name === state.localAgent?.label
            ? action.agent.label
            : state.name,
      };
    case 'SET_NAME':
      return { ...state, name: action.value };
    case 'SET_VOICE':
      return { ...state, voiceId: action.value };
    case 'SAVED':
      return {
        ...state,
        agentId: action.agentId,
        savedName: action.name,
        relinked: action.relinked === true,
        step: 'ready',
      };
    case 'NEXT':
      if (state.step === 'voice' || state.step === 'ready') return state; // Saving moves on.
      return validateComputerStep(state) === undefined ? move(state, 1) : state;
    case 'BACK':
      // Pairing is done once claimed; nothing to go back to after saving either.
      if (state.step === 'agent' || state.step === 'pair' || state.step === 'ready') return state;
      return move(state, -1);
  }
}

/** The last step's words: "Reconnected to <name>" when an old contact was taken over. */
export function readyCopy(state: ComputerState): { heading: string; support: string } {
  const name = (state.savedName ?? state.name).trim();
  return state.relinked === true
    ? {
        heading: `Reconnected to ${name}`,
        support: 'Your chats and calls are still here. Leave your computer on while you call.',
      }
    : { heading: `${name} is ready`, support: 'Leave your computer on while you call.' };
}

export function computerAgentRequest(state: ComputerState): CreateAgentRequest | undefined {
  if (state.connector === undefined || state.localAgent === undefined) return undefined;
  return {
    name: state.name.trim(),
    protocol: 'cord-connector',
    endpoint_url: connectorEndpointUrl(state.connector.id, state.localAgent.id),
    ...(state.voiceId !== undefined && { voice_id: state.voiceId }),
  };
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

const systemSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

/**
 * Polls the pairing until the computer claims it or it expires. A failed poll is retried on the
 * next interval (the phone may briefly lose signal while the user is at their computer).
 */
export async function waitForClaim(
  api: Pick<TwringApi, 'getPairing'>,
  pairingId: string,
  signal: AbortSignal,
  { intervalMs = 2_000, sleep = systemSleep }: { intervalMs?: number; sleep?: Sleep } = {},
): Promise<PairingStatusResponse> {
  for (;;) {
    await sleep(intervalMs, signal);
    try {
      const status = await api.getPairing(pairingId, signal);
      if (status.status !== 'pending') return status;
    } catch (error) {
      if (signal.aborted) throw error;
      // Codes live in the server's memory: after a restart (or once replaced by a newer code)
      // it no longer knows this one, and it will never be claimed. Say so now, not in 10 minutes.
      if (error instanceof ApiError && error.kind === 'http' && error.code === 'not_found') {
        return { status: 'expired', expires_at: new Date().toISOString() };
      }
    }
  }
}
