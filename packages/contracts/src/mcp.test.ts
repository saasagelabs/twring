import { describe, expect, it } from 'vitest';
import {
  agentEndpointUrlSchema,
  createAgentRequestSchema,
  updateAgentRequestSchema,
} from './agents';
import {
  connectedAppSchema,
  connectedAppListResponseSchema,
  checkRepliesInputSchema,
  messageMeInputSchema,
  ringMeInputSchema,
  twringStatusInputSchema,
  callableOnComputer,
  mcpClientKindSchema,
} from './mcp';
import { ringAnswerResponseSchema } from './ring';

describe('MCP contracts', () => {
  it('recognizes only supported local coding agents for calling', () => {
    for (const kind of ['claude-code', 'codex', 'cursor', 'gemini-cli'] as const) {
      expect(mcpClientKindSchema.parse(kind)).toBe(kind);
      expect(callableOnComputer(kind)).toBe(true);
    }
    for (const kind of ['claude', 'chatgpt', 'grok', 'gemini'] as const) {
      expect(callableOnComputer(kind)).toBe(false);
    }
    expect(callableOnComputer(undefined)).toBe(false);
    expect(mcpClientKindSchema.safeParse('unknown').success).toBe(false);
  });
  it('validates connected app rows and chat ring answers', () => {
    const app = {
      client_id: 'claude',
      name: 'Claude',
      blocked: false,
      agent_id: 'agt_abcdefghij0123456789',
      last_used_at: '2026-10-20T00:00:00.000Z',
    };
    expect(connectedAppSchema.parse(app)).toEqual(app);
    expect(connectedAppListResponseSchema.parse({ apps: [app] }).apps).toHaveLength(1);
    expect(connectedAppSchema.safeParse({ ...app, client_id: 'bad/slash' }).success).toBe(false);
    expect(connectedAppSchema.safeParse({ ...app, agent_id: 'bad' }).success).toBe(false);
    expect(connectedAppSchema.safeParse({ ...app, last_used_at: 'yesterday' }).success).toBe(false);
    expect(ringAnswerResponseSchema.parse({ mode: 'chat', agent_id: app.agent_id })).toEqual({
      mode: 'chat',
      agent_id: app.agent_id,
    });
    expect(ringAnswerResponseSchema.safeParse({ mode: 'chat', agent_id: 'bad' }).success).toBe(
      false,
    );
  });
  it('accepts only private gateway-owned AI app endpoints', () => {
    expect(agentEndpointUrlSchema.safeParse('mcp-app://foo:bar').success).toBe(true);
    expect(agentEndpointUrlSchema.safeParse('mcp-app://bad/child').success).toBe(false);
    expect(
      createAgentRequestSchema.safeParse({
        name: 'App',
        protocol: 'mcp-app',
        endpoint_url: 'mcp-app://client',
      }).success,
    ).toBe(false);
    expect(updateAgentRequestSchema.safeParse({ protocol: 'mcp-app' }).success).toBe(false);
    expect(updateAgentRequestSchema.safeParse({ endpoint_url: 'mcp-app://client' }).success).toBe(
      false,
    );
  });

  it('validates the four tool inputs', () => {
    expect(ringMeInputSchema.parse({ reason: '  Hello  ' }).reason).toBe('Hello');
    expect(ringMeInputSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(messageMeInputSchema.safeParse({}).success).toBe(false);
    expect(
      messageMeInputSchema.safeParse({ files: [{ url: 'http://example.com/a' }] }).success,
    ).toBe(false);
    expect(messageMeInputSchema.safeParse({ text: 'Hello' }).success).toBe(true);
    expect(checkRepliesInputSchema.safeParse({ since: '2026-10-20T00:00:00.000Z' }).success).toBe(
      true,
    );
    expect(twringStatusInputSchema.safeParse({ extra: true }).success).toBe(false);
  });
});
