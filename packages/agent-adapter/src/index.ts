/**
 * @twring/agent-adapter
 *
 * The TwringAgentAdapter boundary (docs/AGENT_ADAPTER_SPEC.md), the stream guard every adapter's
 * events pass through, the built-in test agents, and the Twring Native (`cord-agent/1`) adapter with
 * its endpoint guard and connection test, and the REST + SSE (`cord-rest/1`) adapter. The
 * conformance suite (vitest) and the reference agent servers are separate entry points:
 * `@twring/agent-adapter/conformance`, `@twring/agent-adapter/fake-native-server`, and
 * `@twring/agent-adapter/fake-rest-server`.
 */
export * from './adapter';
export * from './connection-test';
export * from './endpoint-guard';
export * from './errors';
export * from './fake-agent';
export * from './native-adapter';
export * from './openai-chat-adapter';
export * from './repeat-agent';
export * from './rest-sse-adapter';
export * from './sse-parser';
export * from './stream-guard';
