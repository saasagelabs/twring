import { randomUUID } from 'node:crypto';

import {
  MAX_STORED_AGENT_MESSAGE_CHARS,
  connectorMessageResponseSchema,
  errorResponseSchema,
  ringResponseSchema,
  ringStatusResponseSchema,
  sanitizeRingText,
  sessionRefSchema,
  sessionScopeSchema,
  truncateRingText,
  type InviteStatus,
} from '@twring/contracts';

import type { LocalAgentConfig } from './agents';
import { apiUrl, checkServerUrl, configDir, type ConnectorConfig } from './config';
import { scopeOfSessionRef } from './pool';

/**
 * `cord-connect ring` (ADR-024): the agent rings its owner's phone. Uses the saved connector token
 * directly, so the relay daemon need not be running. With `wait`, long-polls until the owner
 * answers, declines, or misses it, and the exit code says which.
 */

/** Exit codes for `ring --wait` (without `--wait`, 0 means the phone is ringing). */
export const RING_EXIT = {
  answered: 0,
  error: 1,
  refused: 2,
  declined: 3,
  missed: 4,
  cancelled: 5,
} as const;

export const MESSAGE_EXIT = { sent: 0, error: 1 } as const;

export function firstSentence(text: string): string {
  const clean = text
    .replace(/⟪[^⟫]*⟫/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s+([.!?])/gu, '$1')
    .trim();
  const end = /[.!?](?= |$)/u.exec(clean);
  return end === null ? clean : clean.slice(0, end.index + 1);
}

const DELIVERY_RETRY_MS = [1_000, 5_000, 30_000, 120_000] as const;

/** Delivers a detached turn through chats when supported, falling back to the original call ring. */
export async function deliverBackgroundResult(
  config: ConnectorConfig,
  agentId: string,
  text: string,
  sessionRef: string | undefined,
  turn: { turnId: string; surface: 'call' | 'text'; scope?: string },
  deps: {
    hasOpenChannel(agentId: string, scope?: string): boolean;
    supports(feature: string): boolean;
    print(line: string): void;
    ring?: typeof ringOwner;
    fetch?: FetchFn;
    signal?: AbortSignal;
  },
): Promise<void> {
  // Only a call in the same person's session holds the result back.
  if (deps.hasOpenChannel(agentId, turn.scope)) {
    deps.print('background result not delivered: channel open');
    return;
  }
  if (deps.signal?.aborted) {
    deps.print('background result not delivered: connector stopped');
    return;
  }
  if (deps.supports('messages')) {
    const server = checkServerUrl(config.server);
    const body = JSON.stringify({
      local_agent: agentId,
      text,
      origin: turn.surface === 'call' ? 'call_turn' : 'text_turn',
      turn_id: turn.turnId,
      ...(turn.scope !== undefined && { session_scope: turn.scope }),
      ...(sessionRef !== undefined &&
        sessionRefSchema.safeParse(sessionRef).success && {
          session_ref: sessionRef,
        }),
    });
    for (let attempt = 0; attempt <= DELIVERY_RETRY_MS.length; attempt++) {
      let response: Response | undefined;
      try {
        response = await (deps.fetch ?? fetch)(apiUrl(server, '/v1/connectors/messages'), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.token}`,
            'content-type': 'application/json',
            'Idempotency-Key': turn.turnId,
          },
          body,
          redirect: 'error',
          signal: withTimeout(deps.signal, REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (deps.signal?.aborted) {
          deps.print('background result not delivered: connector stopped');
          return;
        }
      }
      if (response?.ok) {
        const parsed = connectorMessageResponseSchema.safeParse(
          await response.json().catch(() => undefined),
        );
        deps.print(
          parsed.success
            ? `background result delivered (${parsed.data.delivery})`
            : 'background result not delivered: invalid response',
        );
        return;
      }
      if (response?.status === 404) break;
      if (response !== undefined && response.status !== 429 && response.status < 500) {
        deps.print(`background result not delivered: HTTP ${response.status}`);
        return;
      }
      const delay = DELIVERY_RETRY_MS[attempt];
      if (delay === undefined) {
        deps.print('background result not delivered: retries exhausted');
        return;
      }
      if (!(await waitForRetry(delay, deps.signal))) {
        deps.print('background result not delivered: connector stopped');
        return;
      }
    }
  }
  // A ring would reach the computer's owner, not the person this result is for.
  if (turn.surface === 'text' || turn.scope !== undefined) {
    deps.print('background result not delivered: messages unavailable');
    return;
  }
  try {
    const args = [
      config,
      {
        reason: firstSentence(text),
        agent: agentId,
        scope: undefined,
        ...(sessionRef !== undefined &&
          sessionRefSchema.safeParse(sessionRef).success && {
            session: sessionRef,
          }),
        wait: false,
      },
      { print: () => undefined },
    ] satisfies Parameters<typeof ringOwner>;
    const code = await (deps.ring === undefined ? ringOwner(...args) : deps.ring(...args));
    deps.print(
      code === RING_EXIT.answered
        ? 'background result delivered (ring)'
        : `background result not delivered: ring ended with code ${code}`,
    );
  } catch {
    deps.print('background result not delivered: ring failed');
  }
}

/** `signal` plus a deadline. Not `AbortSignal.any`: that needs Node 20.3, and the connector runs on any Node 20. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (signal === undefined) return timeout;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted || timeout.aborted) abort();
  signal.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function waitForRetry(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** How long `--wait` follows one ring before giving up (the ring itself lasts 30 s). */
const WAIT_LIMIT_MS = 90_000;
const POLL_WAIT_S = 25;
/**
 * Deadline for the ring and cancel requests, and on top of the long-poll wait for each poll: a hook
 * (or a terminal) never hangs on a server that accepts the connection and then says nothing.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The team member's session this command runs in (`TWRING_SESSION_SCOPE`, set on a shared server
 * agent's process for someone other than the owner), or undefined.
 */
export function envSessionScope(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const parsed = sessionScopeSchema.safeParse(env.TWRING_SESSION_SCOPE);
  return parsed.success ? parsed.data : undefined;
}

/** `options.scope` when given (even as undefined), else the environment's. */
function scopeOf(options: { scope?: string | undefined }): string | undefined {
  return 'scope' in options ? options.scope : envSessionScope();
}

export interface RingOptions {
  reason: string;
  /** A team member's session; defaults to `TWRING_SESSION_SCOPE`. */
  scope?: string | undefined;
  /** Local agent id; defaults to the only (or first) agent in the pairing. */
  agent?: string;
  session?: string;
  wait: boolean;
}

export interface RingDeps {
  fetch?: FetchFn;
  print: (line: string) => void;
  now?: () => number;
  /** Aborts a `--wait` (Ctrl+C): the ring is cancelled on the server. */
  signal?: AbortSignal;
  /** Keeps the new ring's id so `ring --cancel` can cancel it later. */
  remember?: (inviteId: string) => Promise<void>;
}

/** Picks the local agent that rings: `wanted`, else a single agent, else the first one. */
export function pickAgent(
  config: ConnectorConfig,
  wanted: string | undefined,
): LocalAgentConfig | undefined {
  if (wanted !== undefined) return config.agents.find((a) => a.id === wanted);
  return config.agents[0];
}

/** Saves an agent-initiated message in the owner's Twring chat. */
export async function sendMessage(
  config: ConnectorConfig,
  options: { text: string; agent?: string; scope?: string | undefined },
  deps: {
    print: (line: string) => void;
    fetch?: FetchFn;
    signal?: AbortSignal;
    retryMs?: readonly number[];
  },
): Promise<number> {
  const scope = scopeOf(options);
  const agent = pickAgent(config, options.agent);
  if (agent === undefined) {
    deps.print(
      `No agent "${options.agent ?? ''}" on this computer. Paired agents: ${config.agents.map((a) => a.id).join(', ')}.`,
    );
    return MESSAGE_EXIT.error;
  }
  const text = options.text.trim();
  if (text === '') {
    deps.print('Say what to send, e.g. twring-connect message "The nightly backup finished."');
    return MESSAGE_EXIT.error;
  }
  if (text.length > MAX_STORED_AGENT_MESSAGE_CHARS) {
    deps.print(`The message is too long (maximum ${MAX_STORED_AGENT_MESSAGE_CHARS} characters).`);
    return MESSAGE_EXIT.error;
  }
  const server = checkServerUrl(config.server);
  const refusal = async (res: Response) => {
    const parsed = errorResponseSchema.safeParse(await res.json().catch(() => undefined));
    return parsed.success
      ? parsed.data.error.message
      : `Could not send the message (HTTP ${res.status}).`;
  };
  // One key for every retry of this send, so a retry never makes a second message.
  const idempotencyKey = randomUUID();
  const retryMs = deps.retryMs ?? [1_000, 5_000, 30_000];
  for (let attempt = 0; ; attempt++) {
    if (deps.signal?.aborted) {
      deps.print('Message sending cancelled.');
      return MESSAGE_EXIT.error;
    }
    let response: Response | undefined;
    try {
      response = await (deps.fetch ?? fetch)(apiUrl(server, '/v1/connectors/messages'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          local_agent: agent.id,
          text,
          origin: 'agent',
          ...(scope !== undefined && { session_scope: scope }),
        }),
        redirect: 'error',
        signal: withTimeout(deps.signal, REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (deps.signal?.aborted) {
        deps.print('Message sending cancelled.');
        return MESSAGE_EXIT.error;
      }
    }
    if (response?.status === 200 || response?.status === 201) {
      deps.print('Sent to your Twring chat.');
      return MESSAGE_EXIT.sent;
    }
    if (response?.status === 404) {
      deps.print(
        "This Twring server can't take messages yet, or this agent isn't saved there. Use ring instead.",
      );
      return MESSAGE_EXIT.error;
    }
    if (response !== undefined && response.status !== 429 && response.status < 500) {
      deps.print(await refusal(response));
      return MESSAGE_EXIT.error;
    }
    const delay = retryMs[attempt];
    if (delay === undefined) {
      deps.print(
        response === undefined
          ? `Could not reach ${server.origin}. Check your internet connection.`
          : await refusal(response),
      );
      return MESSAGE_EXIT.error;
    }
    if (!(await waitForRetry(delay, deps.signal))) {
      deps.print('Message sending cancelled.');
      return MESSAGE_EXIT.error;
    }
  }
}

async function errorMessage(res: Response): Promise<{ code?: string; message: string }> {
  const parsed = errorResponseSchema.safeParse(await res.json().catch(() => undefined));
  return parsed.success
    ? { code: parsed.data.error.code, message: parsed.data.error.message }
    : { message: `The server refused the ring (HTTP ${res.status}).` };
}

function outcomeLine(status: InviteStatus, note: string | undefined): string {
  switch (status) {
    case 'answered':
      return 'Answered';
    case 'declined':
      return note === undefined ? 'Declined' : `Declined: ${note}`;
    case 'missed':
      return 'Missed: left a voicemail';
    case 'cancelled':
      return 'Cancelled';
    case 'pending':
      return 'Still ringing';
  }
}

/** Rings the owner. Resolves the process exit code. */
export async function ringOwner(
  config: ConnectorConfig,
  options: RingOptions,
  deps: RingDeps,
): Promise<number> {
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;
  const server = checkServerUrl(config.server);
  const headers = {
    authorization: `Bearer ${config.token}`,
    'content-type': 'application/json',
  };
  const agent = pickAgent(config, options.agent);
  if (agent === undefined) {
    deps.print(
      `No agent "${options.agent ?? ''}" on this computer. Paired agents: ${config.agents.map((a) => a.id).join(', ')}.`,
    );
    return RING_EXIT.error;
  }
  const reason = truncateRingText(sanitizeRingText(options.reason), 140);
  if (reason === '') {
    deps.print('Say why you are ringing, e.g. twring-connect ring "The build finished".');
    return RING_EXIT.error;
  }
  const session =
    options.session !== undefined && sessionRefSchema.safeParse(options.session).success
      ? options.session
      : undefined;
  const scope = scopeOf(options);
  // A team member's session is never rung into for the owner.
  if (scope === undefined && session !== undefined && scopeOfSessionRef(configDir(), session)) {
    deps.print('That session belongs to someone else on this Twring server. Not rung.');
    return RING_EXIT.error;
  }
  const scopeQuery = scope === undefined ? '' : `session_scope=${scope}`;

  let res: Response;
  try {
    res = await doFetch(apiUrl(server, '/v1/connectors/ring'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        local_agent: agent.id,
        reason,
        ...(session !== undefined && { session_ref: session }),
        ...(scope !== undefined && { session_scope: scope }),
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    deps.print(`Could not reach ${server.origin}. Check your internet connection.`);
    return RING_EXIT.error;
  }
  if (!res.ok) {
    const { message } = await errorMessage(res);
    deps.print(message);
    return res.status === 409 || res.status === 404 ? RING_EXIT.refused : RING_EXIT.error;
  }
  const ring = ringResponseSchema.safeParse(await res.json().catch(() => undefined));
  if (!ring.success) {
    deps.print('The server answered the ring in a way this version does not understand.');
    return RING_EXIT.error;
  }
  await deps.remember?.(ring.data.invite_id).catch(() => undefined);
  deps.print('Ringing…');
  if (!options.wait) return 0;

  const baseStatusUrl = apiUrl(server, `/v1/connectors/ring/${ring.data.invite_id}`);
  const statusUrl = scopeQuery === '' ? baseStatusUrl : `${baseStatusUrl}?${scopeQuery}`;
  /**
   * Cancels the ring and says how it actually ended: the owner may have answered or declined just
   * before Ctrl+C, and DELETE then reports that instead. Unknown (offline, odd reply) = cancelled.
   */
  type Ended = { status: Exclude<InviteStatus, 'pending'>; note?: string | undefined };
  const cancel = async (): Promise<Ended> => {
    try {
      const res = await doFetch(statusUrl, {
        method: 'DELETE',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const parsed = ringStatusResponseSchema.safeParse(await res.json().catch(() => undefined));
      if (res.ok && parsed.success) {
        const { status, note } = parsed.data;
        if (status !== 'pending') return { status, note };
      }
    } catch {
      // Fall through: the ring expires on its own.
    }
    return { status: 'cancelled' };
  };
  const aborted = (): boolean => deps.signal?.aborted === true;
  const deadline = now() + WAIT_LIMIT_MS;
  while (now() < deadline) {
    if (aborted()) {
      const ended = await cancel();
      deps.print(outcomeLine(ended.status, ended.note));
      return RING_EXIT[ended.status];
    }
    let poll: Response;
    const pollDeadline = AbortSignal.timeout(POLL_WAIT_S * 1000 + REQUEST_TIMEOUT_MS);
    try {
      poll = await doFetch(`${statusUrl}${scopeQuery === '' ? '?' : '&'}wait=${POLL_WAIT_S}`, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal:
          deps.signal === undefined ? pollDeadline : AbortSignal.any([deps.signal, pollDeadline]),
      });
    } catch {
      if (aborted()) continue;
      deps.print('Lost the connection while ringing.');
      return RING_EXIT.error;
    }
    if (!poll.ok) {
      deps.print((await errorMessage(poll)).message);
      return RING_EXIT.error;
    }
    const status = ringStatusResponseSchema.safeParse(await poll.json().catch(() => undefined));
    if (!status.success) {
      deps.print('The server answered in a way this version does not understand.');
      return RING_EXIT.error;
    }
    if (status.data.status === 'pending') continue;
    deps.print(outcomeLine(status.data.status, status.data.note));
    return RING_EXIT[status.data.status];
  }
  deps.print('Still ringing; stopped waiting.');
  return RING_EXIT.error;
}

/**
 * `ring --cancel`: cancels this computer's last ring if it is still ringing, and says how it
 * ended otherwise. Exit 0 once the ring is over; the ring is kept when the server could not be
 * reached, so the agent can try again.
 */
export async function cancelLastRing(
  config: ConnectorConfig,
  deps: {
    fetch?: FetchFn;
    print: (line: string) => void;
    lastRing: () => Promise<string | undefined>;
    forget: () => Promise<void>;
    scope?: string | undefined;
  },
): Promise<number> {
  const scope = scopeOf(deps);
  const inviteId = await deps.lastRing();
  if (inviteId === undefined) {
    deps.print('No ring to cancel.');
    return RING_EXIT.refused;
  }
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const server = checkServerUrl(config.server);
  let res: Response;
  try {
    const url = apiUrl(server, `/v1/connectors/ring/${inviteId}`);
    res = await doFetch(scope === undefined ? url : `${url}?session_scope=${scope}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${config.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    deps.print(`Could not reach ${server.origin}. Check your internet connection.`);
    return RING_EXIT.error;
  }
  if (res.status === 404) {
    await deps.forget().catch(() => undefined);
    deps.print('No ring to cancel.');
    return RING_EXIT.refused;
  }
  if (!res.ok) {
    deps.print((await errorMessage(res)).message);
    return RING_EXIT.error;
  }
  const parsed = ringStatusResponseSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) {
    deps.print('The server answered in a way this version does not understand.');
    return RING_EXIT.error;
  }
  await deps.forget().catch(() => undefined);
  const { status, note } = parsed.data;
  deps.print(outcomeLine(status === 'pending' ? 'cancelled' : status, note));
  return 0;
}
