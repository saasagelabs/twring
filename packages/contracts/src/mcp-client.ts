import { z } from 'zod';

/**
 * Which MCP client an AI-app contact is, from its `initialize` clientInfo. Kept apart from
 * `mcp.ts`, which imports `agents.ts`: `agents.ts` needs this too, and must not import back.
 */
export const mcpClientKindSchema = z.enum([
  'claude-code',
  'codex',
  'cursor',
  'gemini-cli',
  'claude',
  'chatgpt',
  'grok',
  'gemini',
]);
export type McpClientKind = z.infer<typeof mcpClientKindSchema>;

/** Coding agents that can also take calls once set up on the user's computer. */
export function callableOnComputer(kind: McpClientKind | undefined): boolean {
  return kind === 'claude-code' || kind === 'codex' || kind === 'cursor' || kind === 'gemini-cli';
}
