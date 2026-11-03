import type { AdapterCapabilities, AgentEvent } from '@twring/contracts';

import type { TwringAgentAdapter } from './adapter';
import { AdapterError, isAdapterError } from './errors';
import { systemTimers, type Timers } from './native-adapter';

/** AGENT_ADAPTER_SPEC §16. `safeMessage` is Twring's own text and never carries secrets. */
export interface ConnectionTestResult {
  reachable: boolean;
  authenticated: boolean;
  protocolValid: boolean;
  streamingObserved?: boolean;
  /** The probe turn finished with `done: completed` (set only when the probe ran to its end). */
  completed?: boolean;
  /** Probe turn sent → first agent event. */
  latencyMs?: number;
  capabilities?: AdapterCapabilities;
  safeMessage: string;
}

export interface ConnectionTestOptions {
  /** Budget for connect + handshake. */
  connectTimeoutMs?: number;
  /** Budget for the probe turn to reach `done`. */
  probeTimeoutMs?: number;
  now?: () => number;
  timers?: Timers;
}

/**
 * Whether `connect()` reaches the agent (and so authenticates). The REST adapter only records its
 * configuration there; its first request is the probe turn.
 */
const CONNECT_TOUCHES_NETWORK = (adapter: TwringAgentAdapter): boolean =>
  adapter.name !== 'cord-rest' && adapter.name !== 'openai-chat';

export const CONNECTION_TEST_PROMPT = 'Twring connection test. Reply with OK.';
export const OPENAI_CHAT_TEST_PROMPT =
  'This is a Twring connection test. Reply with the single word: ready';

/**
 * Connects, handshakes, and sends one probe turn, then closes. Every failure is reported as a
 * result, never thrown, so the setup screen can explain what to fix.
 */
export async function testAgentConnection(
  adapterFactory: () => TwringAgentAdapter,
  options: ConnectionTestOptions = {},
): Promise<ConnectionTestResult> {
  const now = options.now ?? (() => performance.now());
  const timers = options.timers ?? systemTimers;
  const adapter = adapterFactory();
  const id = `conntest_${Math.random().toString(36).slice(2, 10)}`;
  try {
    try {
      await withTimeout(timers, options.connectTimeoutMs ?? 10_000, (signal) =>
        adapter.connect({ callId: id, sessionId: id }, signal),
      );
    } catch (error) {
      return connectFailure(error);
    }
    const capabilities = adapter.capabilities;
    let firstEventAt: number | undefined;
    let deltas = 0;
    let last: AgentEvent | undefined;
    const sentAt = now();
    try {
      await withTimeout(timers, options.probeTimeoutMs ?? 15_000, async (signal) => {
        const stamp = new Date().toISOString();
        const turn = {
          callId: id,
          sessionId: id,
          turnId: `${id}_probe`,
          role: 'user' as const,
          text: adapter.name === 'openai-chat' ? OPENAI_CHAT_TEST_PROMPT : CONNECTION_TEST_PROMPT,
          startedAt: stamp,
          committedAt: stamp,
        };
        for await (const event of adapter.sendTurn(turn, signal)) {
          firstEventAt ??= now();
          if (event.type === 'text.delta') deltas += 1;
          last = event;
        }
      });
    } catch (error) {
      const code = isAdapterError(error) ? error.code : 'timeout';
      // Request-per-turn adapters (REST) first touch the agent here, so these mean the agent was
      // never properly reached, just as they would at connect.
      if (
        code === 'auth_failed' ||
        code === 'connection_failed' ||
        code === 'endpoint_rejected' ||
        code === 'agent_error' ||
        code === 'agent_offline'
      ) {
        return connectFailure(error);
      }
      // An adapter whose connect() never touched the network (REST) has no auth verdict until the
      // agent answers: with no event received, say so rather than "Connected, but…".
      if (
        firstEventAt === undefined &&
        !CONNECT_TOUCHES_NETWORK(adapter) &&
        (code === 'timeout' || code === 'connection_lost' || code === 'not_connected')
      ) {
        return {
          reachable: code === 'connection_lost',
          authenticated: false,
          protocolValid: false,
          safeMessage:
            code === 'timeout'
              ? 'The agent did not answer in time. Check the URL and that it is running.'
              : 'The connection to the agent dropped before it answered. Check that it is running.',
        };
      }
      return {
        reachable: true,
        authenticated: true,
        protocolValid: code !== 'protocol_violation',
        capabilities,
        safeMessage:
          code === 'protocol_violation'
            ? 'Connected, but the agent sent a reply Twring could not read.'
            : code === 'timeout'
              ? 'Connected, but the agent did not finish a test reply in time.'
              : 'Connected, but the connection dropped during the test reply.',
      };
    }
    const latencyMs = firstEventAt === undefined ? undefined : Math.round(firstEventAt - sentAt);
    const completed = last?.type === 'done' && last.status === 'completed';
    return {
      reachable: true,
      authenticated: true,
      protocolValid: true,
      streamingObserved: deltas > 1,
      completed,
      ...(latencyMs === undefined ? {} : { latencyMs }),
      capabilities,
      safeMessage: completed
        ? 'Connected. The agent answered the test message.'
        : 'Connected, but the agent reported an error on the test message.',
    };
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

function connectFailure(error: unknown): ConnectionTestResult {
  const code = isAdapterError(error) ? error.code : 'connection_failed';
  switch (code) {
    case 'auth_failed':
      return {
        reachable: true,
        authenticated: false,
        protocolValid: false,
        safeMessage: 'The agent rejected the credentials. Check the token and try again.',
      };
    case 'protocol_unsupported':
    case 'protocol_violation':
      return {
        reachable: true,
        authenticated: true,
        protocolValid: false,
        safeMessage: 'Reached the agent, but it does not speak cord-agent/1.',
      };
    case 'agent_error':
      return {
        reachable: true,
        authenticated: true,
        protocolValid: true,
        safeMessage: 'Reached the agent, but it refused the session.',
      };
    case 'endpoint_rejected':
      return {
        reachable: false,
        authenticated: false,
        protocolValid: false,
        safeMessage: 'That address is not allowed. Use a public wss:// URL.',
      };
    case 'timeout':
      return {
        reachable: false,
        authenticated: false,
        protocolValid: false,
        safeMessage: 'The agent did not answer in time. Check the URL and that it is running.',
      };
    case 'agent_offline':
      return {
        reachable: false,
        authenticated: false,
        protocolValid: false,
        safeMessage: "Your computer isn't connected. Start cord-connect on it, then try again.",
      };
    case 'agent_not_on_computer':
      return {
        reachable: false,
        authenticated: false,
        protocolValid: false,
        safeMessage:
          "This agent isn't set up on your computer anymore. Check cord-connect's agent list.",
      };
    case 'connection_failed':
    case 'connection_lost':
    case 'not_connected':
      return {
        reachable: false,
        authenticated: false,
        protocolValid: false,
        safeMessage: 'Could not reach the agent. Check the URL and that it is running.',
      };
  }
}

async function withTimeout<T>(
  timers: Timers,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let handle: unknown;
  const timeout = new Promise<never>((_, reject) => {
    handle = timers.setTimeout(() => {
      const error = new AdapterError('timeout');
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    timers.clearTimeout(handle);
  }
}
