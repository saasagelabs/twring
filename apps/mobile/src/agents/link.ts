import {
  CONNECTOR_CLI_NAME,
  connectorEndpointUrl,
  parseLinkInput,
  type CreateAgentRequest,
  type LinkAgent,
  type LinkApproveResponse,
  type LinkRequestDetails,
} from '@twring/contracts';

import { ApiError } from '../api/client';
import { apiErrorCopy, type ErrorCopy } from '../api/errors';
import { connectorDownloadUrl, serverBase } from './agent-message';

/**
 * "On my computer", computer first (ADR-025), as a pure reducer: the computer runs
 * the downloaded connector and shows a QR code; the phone scans it (or the code is typed), confirms the
 * computer by name, approves, and adds the agents it found.
 */
export type LinkStep = 'start' | 'scan' | 'type' | 'confirm' | 'pick' | 'done';

/**
 * Whether a busy step's request needs the link code. Saving the picked agents does not: a
 * computer linked by an agent message (ADR-027) reaches the picker with no code at all.
 */
export function stepNeedsLinkCode(step: LinkStep): boolean {
  return step === 'scan' || step === 'type' || step === 'confirm';
}

export interface LinkState {
  step: LinkStep;
  /** What the user typed on the "type the code" step. */
  typed: string;
  /** The code being confirmed, as `XXXX-XXXX`. */
  code?: string;
  details?: LinkRequestDetails;
  /** Set once approved: the computer now belongs to this account. */
  linked?: LinkApproveResponse;
  /** Local agent ids chosen on the picker. */
  selected: string[];
  /** Local agent ids already saved, so a retry never adds one twice. */
  saved: string[];
  /** Local agent id to contact name, for contacts a computer linked again took over. */
  reconnected?: Record<string, string>;
  busy: boolean;
  error?: ErrorCopy;
}

export type LinkAction =
  | { type: 'OPEN_SCANNER' }
  | { type: 'TYPE_INSTEAD' }
  | { type: 'SET_TYPED'; value: string }
  | { type: 'BACK' }
  | { type: 'LOOKUP_STARTED'; code: string }
  | { type: 'FOUND'; details: LinkRequestDetails }
  | { type: 'FAILED'; copy: ErrorCopy }
  | { type: 'APPROVE_STARTED' }
  /** `alreadyAdded`: local agents this phone saved before (a re-linked computer, ADR-027). */
  | { type: 'APPROVED'; linked: LinkApproveResponse; alreadyAdded?: readonly string[] }
  | { type: 'TOGGLE'; localAgent: string }
  | { type: 'SAVE_STARTED' }
  | { type: 'AGENT_SAVED'; localAgent: string; relinkedAs?: string }
  | { type: 'ALL_SAVED' };

export function createLinkWizard(): LinkState {
  return { step: 'start', typed: '', selected: [], saved: [], busy: false };
}

/** Download the connector and start its no-code QR linking flow on this app's server. */
export function linkCommand(server: string, downloads: string = server): string | undefined {
  const base = serverBase(server);
  const download = connectorDownloadUrl(server, downloads);
  if (base === undefined || download === undefined) return undefined;
  const file = `${CONNECTOR_CLI_NAME}.mjs`;
  return `curl -fsSL ${download} -o ${file} && node ${file} --server ${base}`;
}

/**
 * Same server when scheme, host, port, and path match (ASCII case and trailing slash aside). Only
 * A-Z is folded: `toLowerCase` would also turn look-alikes such as the Kelvin sign into ASCII.
 */
export function sameServer(a: string, b: string): boolean {
  const norm = (url: string) =>
    url
      .trim()
      .replace(/\/+$/, '')
      .replace(/[A-Z]/g, (c) => c.toLowerCase());
  return norm(a) === norm(b);
}

export type ReadInput = { ok: true; code: string } | { ok: false; message: string };

/**
 * A scanned QR code or a typed code, checked against this app's server. A QR code made for
 * another server is refused so nothing of this account is ever sent there.
 */
export function readLinkInput(input: string, apiBaseUrl: string): ReadInput {
  const parsed = parseLinkInput(input);
  if (parsed === undefined) {
    return { ok: false, message: 'That is not a Twring code. Check the code on your computer.' };
  }
  if (parsed.server !== undefined && !sameServer(parsed.server, apiBaseUrl)) {
    return {
      ok: false,
      message:
        'That code is for a different Twring server than this app uses, so it was not used. Get a new code on your computer.',
    };
  }
  return { ok: true, code: parsed.code };
}

/** The computer's code ran out, or the computer stopped waiting (the server answers 410). */
export const LINK_EXPIRED_COPY: ErrorCopy = {
  message: 'That code expired. Get a new code on your computer and try again.',
  retryable: false,
};

/** User copy for a failed lookup or approval: an expired code says so, the rest as usual. */
export function linkErrorCopy(error: unknown): ErrorCopy {
  if (
    error instanceof ApiError &&
    error.kind === 'http' &&
    error.status === 410 &&
    error.code === 'pairing_invalid'
  ) {
    return LINK_EXPIRED_COPY;
  }
  return apiErrorCopy(error);
}

/** A one-line description for an agent the computer found. */
export function agentDescription(agent: Pick<LinkAgent, 'local_agent' | 'kind'>): string {
  switch (agent.local_agent) {
    case 'claude-code':
      return "Anthropic's coding agent";
    case 'codex':
      return "OpenAI's coding agent";
    case 'gemini':
      return "Google's command-line agent";
    case 'hermes':
      return "Nous Research's agent";
  }
  switch (agent.kind) {
    case 'claude-code':
      return "Anthropic's coding agent";
    case 'codex':
      return "OpenAI's coding agent";
    case 'acp':
    case 'command':
    case 'openai':
      return 'An agent on your computer';
  }
}

/** "Link Work laptop?" */
export function confirmTitle(details: LinkRequestDetails): string {
  return `Link ${details.computer_name}?`;
}

export function addLabel(count: number): string {
  return count === 1 ? 'Add 1 agent' : `Add ${count} agents`;
}

/** The picker's button: how many agents it adds, or Continue when all are already on the phone. */
export function pickLabel(state: Pick<LinkState, 'selected' | 'saved'>): string {
  const count = state.selected.filter((id) => !state.saved.includes(id)).length;
  return count === 0 ? 'Continue' : addLabel(count);
}

/**
 * What Back (the header button or Android's back) does: step back from a code step, cancel (reject)
 * on the confirm step, or leave. Nothing while a request that cannot be taken back is in flight:
 * the approval (the computer is being linked) or adding agents.
 */
export function linkBackAction(state: LinkState): 'step-back' | 'cancel' | 'leave' | 'stay' {
  switch (state.step) {
    case 'scan':
    case 'type':
      return 'step-back';
    case 'confirm':
      return state.busy ? 'stay' : 'cancel';
    case 'pick':
      return state.busy ? 'stay' : 'leave';
    case 'start':
    case 'done':
      return 'leave';
  }
}

export function linkReducer(state: LinkState, action: LinkAction): LinkState {
  switch (action.type) {
    case 'OPEN_SCANNER':
      return state.step === 'start' || state.step === 'type'
        ? { ...state, step: 'scan', error: undefined }
        : state;
    case 'TYPE_INSTEAD':
      return state.step === 'start' || state.step === 'scan'
        ? { ...state, step: 'type', error: undefined }
        : state;
    case 'SET_TYPED':
      // Auto-uppercase; the dash is optional and added back when read.
      return { ...state, typed: action.value.toUpperCase().slice(0, 12), error: undefined };
    case 'BACK':
      // Only the code steps step back here. Confirm cancels (the screen rejects); pick and done
      // are past the point of return.
      // Leaving a code step drops any lookup in flight (the screen aborts it).
      return state.step === 'scan' || state.step === 'type'
        ? { ...state, step: 'start', busy: false, error: undefined }
        : state;
    case 'LOOKUP_STARTED':
      return { ...state, code: action.code, busy: true, error: undefined };
    case 'FOUND':
      return { ...state, details: action.details, step: 'confirm', busy: false };
    case 'FAILED':
      return { ...state, busy: false, error: action.copy };
    case 'APPROVE_STARTED':
      return state.step === 'confirm' ? { ...state, busy: true, error: undefined } : state;
    case 'APPROVED':
      return {
        ...state,
        linked: action.linked,
        step: 'pick',
        busy: false,
        // Every detected agent starts selected; those already on the phone stay checked, locked.
        selected: action.linked.agents.map((a) => a.local_agent),
        saved: action.linked.agents
          .map((a) => a.local_agent)
          .filter((id) => action.alreadyAdded?.includes(id) === true),
      };
    case 'TOGGLE': {
      if (state.step !== 'pick' || state.busy) return state;
      const on = state.selected.includes(action.localAgent);
      return {
        ...state,
        selected: on
          ? state.selected.filter((id) => id !== action.localAgent)
          : [...state.selected, action.localAgent],
      };
    }
    case 'SAVE_STARTED':
      return state.step === 'pick' && state.selected.length > 0
        ? { ...state, busy: true, error: undefined }
        : state;
    case 'AGENT_SAVED':
      return state.saved.includes(action.localAgent)
        ? state
        : {
            ...state,
            saved: [...state.saved, action.localAgent],
            ...(action.relinkedAs !== undefined && {
              reconnected: { ...state.reconnected, [action.localAgent]: action.relinkedAs },
            }),
          };
    case 'ALL_SAVED':
      return { ...state, step: 'done', busy: false };
  }
}

/**
 * The agents still to save, each with its own name and the default voice. Agents saved by an
 * earlier attempt are skipped.
 */
export function pendingAgentRequests(
  state: LinkState,
): { localAgent: string; request: CreateAgentRequest }[] {
  const linked = state.linked;
  if (linked === undefined) return [];
  return linked.agents
    .filter((a) => state.selected.includes(a.local_agent) && !state.saved.includes(a.local_agent))
    .map((a) => ({
      localAgent: a.local_agent,
      request: {
        name: a.label,
        protocol: 'cord-connector',
        endpoint_url: connectorEndpointUrl(linked.connector_id, a.local_agent),
      },
    }));
}

/**
 * The last step's words. One agent that took over its old contact: "Reconnected to <name>";
 * otherwise the usual heading, with reconnected ones marked in the list.
 */
export function doneCopy(state: LinkState): {
  heading: string;
  support: string;
  reconnected: Record<string, string>;
} {
  const reconnected = state.reconnected ?? {};
  const names = Object.values(reconnected);
  if (state.saved.length === 1 && names.length === 1) {
    return {
      heading: `Reconnected to ${names[0]}`,
      support: 'Your chats and calls are still here. Leave your computer on while you call.',
      reconnected,
    };
  }
  return {
    heading: 'Your agents are ready',
    support: 'Call them from Home. Leave your computer on while you call.',
    reconnected,
  };
}
