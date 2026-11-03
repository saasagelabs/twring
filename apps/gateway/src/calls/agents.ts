import {
  assertSafeAgentEndpoint,
  FakeAgentAdapter,
  NativeWsAdapter,
  OpenAiChatAdapter,
  RepeatAgentAdapter,
  RestSseAdapter,
  type TwringAgentAdapter,
  type EndpointGuardOptions,
} from '@twring/agent-adapter';
import { nativeAgentConfig, restAgentConfig, type GatewayEnv } from '@twring/config/gateway';

import { CALL_TIMEOUTS } from './limits';

/**
 * Builds the agent one call talks to. Rejects (an `AdapterError` where possible) when the agent
 * cannot be used; the runtime then ends the call as `agent_unavailable`.
 */
export type AgentFactory = (callId: string) => Promise<TwringAgentAdapter>;

/** The built-in test agents: `agent` = scripted fake agent, `repeat` = says back what it heard. */
export function builtInAgentFactory(mode: 'agent' | 'repeat'): AgentFactory {
  return () =>
    Promise.resolve(mode === 'repeat' ? new RepeatAgentAdapter() : new FakeAgentAdapter());
}

export interface NativeAgentFactoryOptions {
  url: string;
  /** Server-side secret; sent only as the agent's bearer token, never logged. */
  token?: string;
  env: GatewayEnv['CORD_ENV'];
  /** Test seam for the SSRF guard's DNS lookup. */
  lookup?: EndpointGuardOptions['lookup'];
  /**
   * Bounds the guard's DNS lookup. The default (`DNS_LOOKUP_TIMEOUT_MS`) sits well inside
   * `CALL_TIMEOUTS.agentConnectMs`, so a silent resolver cannot stall a call's connect.
   */
  lookupTimeoutMs?: number;
}

/**
 * A Twring Native (`cord-agent/1`) agent per call. The endpoint passes the SSRF guard first, and the
 * socket connects to exactly the address the guard validated (no DNS rebinding in between).
 */
export function nativeAgentFactory(options: NativeAgentFactoryOptions): AgentFactory {
  return async () => {
    const { pinned } = await assertSafeAgentEndpoint(options.url, {
      env: options.env,
      ...(options.lookup && { lookup: options.lookup }),
      ...(options.lookupTimeoutMs !== undefined && { lookupTimeoutMs: options.lookupTimeoutMs }),
    });
    return new NativeWsAdapter({
      url: options.url,
      ...(options.token !== undefined && { token: options.token }),
      pinnedAddress: pinned,
      // A cold agent can take several seconds to answer session.hello. The runtime still bounds
      // the whole connect by the same budget.
      timeouts: { handshakeMs: CALL_TIMEOUTS.agentConnectMs },
    });
  };
}

export type RestAgentFactoryOptions = NativeAgentFactoryOptions;

/**
 * A REST + SSE (`cord-rest/1`) agent per call. The endpoint passes the SSRF guard first, and every
 * request connects to exactly the address the guard validated (no DNS rebinding in between).
 */
export function restAgentFactory(options: RestAgentFactoryOptions): AgentFactory {
  return async () => {
    const { pinned } = await assertSafeAgentEndpoint(options.url, {
      env: options.env,
      ...(options.lookup && { lookup: options.lookup }),
      ...(options.lookupTimeoutMs !== undefined && { lookupTimeoutMs: options.lookupTimeoutMs }),
    });
    return new RestSseAdapter({
      url: options.url,
      ...(options.token !== undefined && { token: options.token }),
      pinnedAddress: pinned,
    });
  };
}

export function openAiChatFactory(
  options: RestAgentFactoryOptions & { model?: string; sessionKey: string },
): AgentFactory {
  return async () => {
    const { pinned } = await assertSafeAgentEndpoint(options.url, {
      env: options.env,
      ...(options.lookup && { lookup: options.lookup }),
      ...(options.lookupTimeoutMs !== undefined && { lookupTimeoutMs: options.lookupTimeoutMs }),
    });
    return new OpenAiChatAdapter({
      url: options.url,
      sessionKey: options.sessionKey,
      ...(options.model !== undefined && { model: options.model }),
      ...(options.token !== undefined && { token: options.token }),
      pinnedAddress: pinned,
    });
  };
}

/** The agent factory for the configured audio mode; undefined for modes without a conversation. */
export function agentFactoryFor(
  env: Pick<
    GatewayEnv,
    | 'GATEWAY_AUDIO_TEST_MODE'
    | 'CORD_ENV'
    | 'AGENT_NATIVE_URL'
    | 'AGENT_NATIVE_TOKEN'
    | 'AGENT_REST_URL'
    | 'AGENT_REST_TOKEN'
  >,
): AgentFactory | undefined {
  switch (env.GATEWAY_AUDIO_TEST_MODE) {
    case 'agent':
    case 'repeat':
      return builtInAgentFactory(env.GATEWAY_AUDIO_TEST_MODE);
    case 'native': {
      const native = nativeAgentConfig(env);
      return native && nativeAgentFactory({ ...native, env: env.CORD_ENV });
    }
    case 'rest': {
      const rest = restAgentConfig(env);
      return rest && restAgentFactory({ ...rest, env: env.CORD_ENV });
    }
    case 'echo':
    case 'tone':
    case 'off':
      return undefined;
  }
}
