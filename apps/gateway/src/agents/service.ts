import {
  AdapterError,
  assertSafeAgentEndpoint,
  DNS_LOOKUP_TIMEOUT_MS,
  isAdapterError,
  isEndpointUnresolvable,
  testAgentConnection,
  type TwringAgentAdapter,
  type ConnectionTestResult,
  type EndpointGuardOptions,
} from '@twring/agent-adapter';
import type { GatewayEnv } from '@twring/config/gateway';
import {
  parseConnectorEndpoint,
  type AdapterCapabilities,
  type AgentProtocol,
  type ConnectionCheck,
  type ConnectionTestSummary,
} from '@twring/contracts';

import {
  nativeAgentFactory,
  openAiChatFactory,
  restAgentFactory,
  type AgentFactory,
} from '../calls/agents';
import { CALL_TIMEOUTS } from '../calls/limits';
import type { ConnectorHub } from '../connectors/hub';
import { ConnectorRelayAdapter } from '../connectors/relay-adapter';
import { revisionOf, type AgentRecord, type Stores } from '../store/repositories';

export interface AgentTarget {
  protocol: AgentProtocol;
  url: string;
  /** Plaintext bearer token, held only for this use. */
  token?: string;
  model?: string;
  sessionKey?: string;
  /** The owner; a `cord-connector` agent can only reach this user's own computer. */
  userId?: string;
  /** `cord-connector` only: the agent session to resume (an answered ring, ADR-024). */
  resumeRef?: string;
  consumeFreshSession?: () => Promise<boolean>;
  /**
   * `cord-connector` only, self-hosted shared agents: someone other than the owner, so their own
   * session on the computer (`userId` stays the owner, whose computer it is).
   */
  sessionScope?: string;
}

export interface EndpointPolicy {
  env: GatewayEnv['CORD_ENV'];
  /** Test seam for the SSRF guard's DNS lookup. */
  lookup?: EndpointGuardOptions['lookup'];
  /** Bounds the guard's DNS lookup; defaults to `DNS_LOOKUP_TIMEOUT_MS`. */
  lookupTimeoutMs?: number;
  /** Live connector sockets, for `cord-connector` agents (ADR-023). */
  connectors?: ConnectorHub;
}

function guardOptions(policy: EndpointPolicy): EndpointGuardOptions {
  return {
    env: policy.env,
    ...(policy.lookup && { lookup: policy.lookup }),
    ...(policy.lookupTimeoutMs !== undefined && { lookupTimeoutMs: policy.lookupTimeoutMs }),
  };
}

/** An agent factory for a saved agent's protocol; the SSRF guard runs on every connect. */
export function targetAgentFactory(target: AgentTarget, policy: EndpointPolicy): AgentFactory {
  if (target.protocol === 'mcp-app') throw new AdapterError('not_connected', { retryable: false });
  if (target.protocol === 'cord-connector') {
    const parsed = parseConnectorEndpoint(target.url);
    const endpoint =
      parsed === undefined || target.resumeRef === undefined
        ? parsed
        : { ...parsed, resumeRef: target.resumeRef };
    const hub = policy.connectors;
    const userId = target.userId;
    return () =>
      hub === undefined || userId === undefined || endpoint === undefined
        ? Promise.reject(new AdapterError('agent_offline', { retryable: false }))
        : Promise.resolve(
            new ConnectorRelayAdapter(
              hub,
              userId,
              endpoint,
              {
                handshakeMs: CALL_TIMEOUTS.agentConnectMs,
              },
              target.consumeFreshSession,
              target.sessionScope,
            ),
          );
  }
  const options = {
    url: target.url,
    env: policy.env,
    ...(target.token !== undefined && { token: target.token }),
    ...(policy.lookup && { lookup: policy.lookup }),
    ...(policy.lookupTimeoutMs !== undefined && { lookupTimeoutMs: policy.lookupTimeoutMs }),
  };
  if (target.protocol === 'cord-native') return nativeAgentFactory(options);
  if (target.protocol === 'openai-chat') {
    if (target.sessionKey === undefined) throw new AdapterError('not_connected');
    return openAiChatFactory({
      ...options,
      sessionKey: target.sessionKey,
      ...(target.model && { model: target.model }),
    });
  }
  return restAgentFactory(options);
}

const NO_CAPABILITIES: AdapterCapabilities = {
  streamingText: false,
  cancellation: false,
  resumableStream: false,
  activityEvents: false,
  toolEvents: false,
  approvals: false,
  conversationResume: false,
  serverInitiatedCalls: false,
};

/**
 * Stands in for a saved agent that was deleted or edited after the call was set up. It never
 * opens a connection: `connect` fails, so the runtime ends the call as `agent_unavailable`.
 */
class ChangedAgentAdapter implements TwringAgentAdapter {
  readonly name = 'changed-agent';
  readonly capabilities = NO_CAPABILITIES;

  connect(): Promise<void> {
    return Promise.reject(
      new AdapterError('connection_failed', {
        detail: 'agent changed after the call started',
        retryable: false,
      }),
    );
  }

  sendTurn(): AsyncIterable<never> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new AdapterError('not_connected')),
      }),
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * The factory a call uses for a saved agent. At connect it re-reads the agent and its credential
 * together, and connects only while the agent is still exactly the revision the call was set up
 * with: a delete or an edit in between (endpoint, protocol, or credential) never sends a
 * credential to an address it was not saved with. The credential is decrypted inside the gateway
 * only here and is never logged; a decrypt failure ends the call as `agent_unavailable`.
 */
export function savedAgentFactory(
  userId: string,
  agent: AgentRecord,
  stores: Pick<Stores, 'agents' | 'credentials'>,
  policy: EndpointPolicy,
  resumeRef?: string,
  /** Self-hosted shared agents: someone other than the owner (`userId`), in their own session. */
  caller?: { scope: string },
): AgentFactory {
  const unchanged = (record: AgentRecord | undefined): record is AgentRecord =>
    record !== undefined &&
    revisionOf(record) === revisionOf(agent) &&
    record.updated_at === agent.updated_at;
  return async (callId) => {
    if (!unchanged(await stores.agents.get(userId, agent.id))) return new ChangedAgentAdapter();
    const token = await stores.credentials.get(userId, agent.id);
    // An edit removes the old credential, then changes the record, then stores the new
    // credential; so a record still unchanged after this read means the token belongs to it.
    const current = await stores.agents.get(userId, agent.id);
    if (!unchanged(current)) return new ChangedAgentAdapter();
    const sessionKey =
      current.protocol === 'openai-chat'
        ? await stores.agents.ensureSessionKey(userId, agent.id)
        : undefined;
    const target = {
      protocol: current.protocol,
      url: current.endpoint_url,
      userId,
      ...(current.model !== undefined && { model: current.model }),
      ...(sessionKey !== undefined && { sessionKey }),
      ...(token !== undefined && { token }),
      ...(resumeRef !== undefined && { resumeRef }),
      ...(current.protocol === 'cord-connector' && {
        consumeFreshSession: () =>
          stores.agents.consumeFreshSession(userId, agent.id, caller?.scope),
        ...(caller !== undefined && { sessionScope: caller.scope }),
      }),
    };
    return targetAgentFactory(target, policy)(callId);
  };
}

/** What the SSRF/TLS guard made of an endpoint. */
export type EndpointVerdict = 'allowed' | 'rejected' | 'unresolvable';

/** Runs the SSRF/TLS guard with a bounded DNS lookup. Never throws. */
export async function checkEndpoint(url: string, policy: EndpointPolicy): Promise<EndpointVerdict> {
  try {
    await assertSafeAgentEndpoint(url, guardOptions(policy));
    return 'allowed';
  } catch (error) {
    return isEndpointUnresolvable(error) ? 'unresolvable' : 'rejected';
  }
}

/** True when the endpoint passes the SSRF/TLS guard. Never throws. */
export async function isEndpointAllowed(url: string, policy: EndpointPolicy): Promise<boolean> {
  return (await checkEndpoint(url, policy)) === 'allowed';
}

export const ENDPOINT_REJECTED_MESSAGE =
  'That address is not allowed. Use a public https:// or wss:// address.';

export const ENDPOINT_UNRESOLVABLE_MESSAGE =
  "We couldn't look up that address. Check it and try again.";

export interface ConnectionTestBudget {
  connectTimeoutMs: number;
  probeTimeoutMs: number;
}

/** Bounds the whole test at about 20 s, so the setup screen never waits indefinitely. */
export const DEFAULT_TEST_BUDGET: ConnectionTestBudget = {
  connectTimeoutMs: 8_000,
  probeTimeoutMs: 12_000,
};

/** Runs the server-side connection test (AGENT_ADAPTER_SPEC §16) and returns a safe summary. */
export async function runConnectionTest(
  target: AgentTarget,
  policy: EndpointPolicy,
  budget: ConnectionTestBudget,
  now: () => Date,
): Promise<ConnectionTestSummary> {
  let adapter;
  // The DNS lookup counts against the connect budget, so a silent resolver cannot stall the test.
  const lookupTimeoutMs = Math.min(
    policy.lookupTimeoutMs ?? DNS_LOOKUP_TIMEOUT_MS,
    budget.connectTimeoutMs,
  );
  try {
    adapter = await targetAgentFactory(target, { ...policy, lookupTimeoutMs })('conntest');
  } catch (error) {
    const rejected = isAdapterError(error) && error.code === 'endpoint_rejected';
    return {
      ok: false,
      checks: [{ name: 'endpoint', status: 'failed' }],
      message: isEndpointUnresolvable(error)
        ? ENDPOINT_UNRESOLVABLE_MESSAGE
        : rejected
          ? ENDPOINT_REJECTED_MESSAGE
          : 'Could not reach the agent.',
      tested_at: now().toISOString(),
    };
  }
  const result = await testAgentConnection(() => adapter, budget);
  return summarize(result, now());
}

/** Only the checks the test actually got to (UX §7), with Twring's own wording. */
export function summarize(result: ConnectionTestResult, testedAt: Date): ConnectionTestSummary {
  const pass = (value: boolean | undefined): ConnectionCheck['status'] =>
    value === true ? 'passed' : 'failed';
  const checks: ConnectionCheck[] = [{ name: 'endpoint', status: pass(result.reachable) }];
  if (result.reachable) checks.push({ name: 'authentication', status: pass(result.authenticated) });
  if (result.reachable && result.authenticated) {
    checks.push({
      name: 'response',
      status: pass(result.protocolValid && result.completed === true),
    });
  }
  if (result.completed === true) {
    checks.push({ name: 'streaming', status: pass(result.streamingObserved) });
  }
  const ok = result.completed === true;
  return {
    ok,
    checks,
    message: ok ? 'Your agent is ready to call.' : result.safeMessage,
    ...(result.latencyMs !== undefined && { latency_ms: Math.max(0, result.latencyMs) }),
    tested_at: testedAt.toISOString(),
  };
}
