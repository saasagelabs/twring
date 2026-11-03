import {
  localAgentIdSchema,
  localAgentKindSchema,
  SESSION_REF_PATTERN,
  type LocalAgent,
} from '@twring/contracts';
import { z } from 'zod';

import { AcpAdapter } from './adapters/acp';
import {
  ClaudeCodeAdapter,
  EDIT_TOOLS,
  READ_ONLY_TOOLS,
  resolveClaudeBin,
} from './adapters/claude-code';
import { CodexAdapter } from './adapters/codex';
import { CommandAdapter } from './adapters/command';
import { OpenAIAdapter } from './adapters/openai';
import type { LocalAgentAdapter } from './events';
import { callPreamble } from './preamble';
import { findExecutable, type SpawnFn } from './process';

/**
 * How to start one agent on this computer. Stays in the local config file; Twring only learns the
 * id, label, and kind.
 */
export const localAgentConfigSchema = z.object({
  id: localAgentIdSchema,
  label: z.string().min(1).max(60),
  kind: localAgentKindSchema,
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  model: z.string().optional(),
  keyEnv: z.string().optional(),
  /** Working directory the agent runs in. */
  cwd: z.string().min(1),
  /** claude-code: also allow Edit and Write (default: read and search only). */
  allowEdits: z.boolean().optional(),
  /** acp: tool kinds allowed when the agent asks permission (default: none). */
  allowKinds: z.array(z.string()).optional(),
  /** codex: `workspace-write` instead of the default `read-only` sandbox. */
  codexSandbox: z.enum(['read-only', 'workspace-write']).optional(),
});
export type LocalAgentConfig = z.infer<typeof localAgentConfigSchema>;

export function publicAgent(config: LocalAgentConfig): LocalAgent {
  return { id: config.id, label: config.label, kind: config.kind };
}

interface KnownAgent {
  id: string;
  label: string;
  kind: LocalAgentConfig['kind'];
  bin: string;
  args: string[];
}

/**
 * Agents found by name on PATH. Gemini CLI speaks ACP natively (`--acp`); Hermes has an ACP server
 * (`hermes acp`); Claude Code and Codex use their own documented machine interfaces.
 */
export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { id: 'claude-code', label: 'Claude Code', kind: 'claude-code', bin: 'claude', args: [] },
  { id: 'codex', label: 'Codex', kind: 'codex', bin: 'codex', args: [] },
  // --skip-trust: headless Gemini CLI refuses an untrusted folder; the owner chose this folder by
  // starting cord-connect in it (https://geminicli.com/docs/cli/trusted-folders/).
  {
    id: 'gemini',
    label: 'Gemini CLI',
    kind: 'acp',
    bin: 'gemini',
    args: ['--acp', '--skip-trust'],
  },
  { id: 'hermes', label: 'Hermes', kind: 'acp', bin: 'hermes', args: ['acp'] },
];

export function detectAgents(
  cwd: string,
  find: (bin: string) => boolean = (bin) => findExecutable(bin) !== undefined,
): LocalAgentConfig[] {
  return KNOWN_AGENTS.filter((agent) => find(agent.bin)).map((agent) => ({
    id: agent.id,
    label: agent.label,
    kind: agent.kind,
    command: agent.kind === 'claude-code' ? resolveClaudeBin() : agent.bin,
    args: agent.args,
    cwd,
  }));
}

/**
 * A team member's session: the agent's process gets `TWRING_SESSION_SCOPE`, so the ring, message
 * and words commands it runs (and its hooks) reach that person. Unscoped: unchanged.
 */
export function scopedSpawn(spawn: SpawnFn, scope: string | undefined): SpawnFn {
  if (scope === undefined) return spawn;
  return (request) => spawn({ ...request, env: { ...request.env, TWRING_SESSION_SCOPE: scope } });
}

/** Session references go back on a command line or into JSON-RPC: plain ids only. */
const RESUME_REF = SESSION_REF_PATTERN;

/**
 * A new adapter for one call. With `resumeRef` (an answered ring, ADR-024) the agent resumes that
 * session where its interface allows; a failed resume falls back to a new session.
 */
export function createAdapter(
  config: LocalAgentConfig,
  baseSpawn: SpawnFn,
  resumeRef?: string,
  /** A team member's own session on a shared server agent. */
  scope?: string,
): LocalAgentAdapter {
  const resume = resumeRef !== undefined && RESUME_REF.test(resumeRef) ? resumeRef : undefined;
  const spawn = scopedSpawn(baseSpawn, scope);
  switch (config.kind) {
    case 'claude-code':
      return new ClaudeCodeAdapter({
        command: config.command,
        cwd: config.cwd,
        tools: config.allowEdits === true ? EDIT_TOOLS : READ_ONLY_TOOLS,
        spawn,
        ...(resume !== undefined && { resume }),
        ...(scope !== undefined && { scope }),
      });
    case 'codex':
      return new CodexAdapter({
        command: config.command,
        cwd: config.cwd,
        spawn,
        sandbox: config.codexSandbox ?? 'read-only',
        preamble: callPreamble(undefined, scope),
        ...(resume !== undefined && { resume }),
      });
    case 'acp':
      return new AcpAdapter({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        ...(config.env !== undefined && { env: config.env }),
        spawn,
        allowKinds: config.allowKinds ?? [],
        preamble: callPreamble(undefined, scope),
        ...(resume !== undefined && { resume }),
      });
    case 'openai':
      return new OpenAIAdapter({
        id: config.id,
        url: config.url ?? '',
        model: config.model ?? 'default',
        keyEnv: config.keyEnv,
        resume,
      });
    case 'command':
      return new CommandAdapter({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        spawn,
      });
  }
}
