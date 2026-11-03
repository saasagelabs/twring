import { z } from 'zod';
import { findExecutable } from './process';
import type { LocalAgentConfig } from './agents';

export function splitCommandLine(input: string): string[] {
  const result: string[] = [];
  let word = '',
    quote = '',
    started = false,
    escape = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (escape) {
      word += char;
      escape = false;
      started = true;
    } else if (char === '\\') {
      const next = input[i + 1];
      if (next === undefined) escape = true;
      else if (
        next === '\\' ||
        next === quote ||
        (!quote && (next === '"' || next === "'" || /\s/u.test(next)))
      )
        escape = true;
      else {
        word += char;
        started = true;
      }
    } else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) {
        result.push(word);
        word = '';
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote || escape) throw new Error('The command has an unfinished quote or escape.');
  if (started) result.push(word);
  if (!result[0]) throw new Error('Enter an ACP command.');
  return result;
}

const executable = z.object({
  package: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export const registrySchema = z.object({
  agents: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      version: z.string(),
      description: z.string(),
      distribution: z.object({
        npx: executable.optional(),
        uvx: executable.optional(),
        binary: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
  ),
});
export type Registry = z.infer<typeof registrySchema>;

export async function fetchRegistry(doFetch: typeof fetch = fetch): Promise<Registry> {
  const response = await doFetch(
    'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
    { signal: AbortSignal.timeout(10_000), redirect: 'error' },
  );
  if (!response.ok || response.body === null) throw new Error('Could not load the ACP registry.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = (await reader.read()) as { done: boolean; value?: unknown };
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('The ACP registry is invalid.');
      total += value.byteLength;
      if (total > 2_000_000) throw new Error('The ACP registry is too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return registrySchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    throw new Error('The ACP registry is invalid.');
  }
}

export function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '')
      .slice(0, 48) || 'agent'
  );
}
export function uniqueId(label: string, used: readonly string[]): string {
  const base = slug(label);
  let id = base,
    index = 2;
  while (used.includes(id)) id = `${base}-${index++}`;
  return id;
}
export function registryAgent(
  registry: Registry,
  id: string,
  cwd: string,
  used: readonly string[],
  find: (name: string) => boolean = (name) => findExecutable(name) !== undefined,
): { agent: LocalAgentConfig; version: string } {
  const entry = registry.agents.find((item) => item.id === id);
  if (!entry) throw new Error(`No ACP registry agent has id "${id}".`);
  const choice =
    find('npx') && entry.distribution.npx
      ? { bin: 'npx', spec: entry.distribution.npx, args: ['-y'] }
      : find('uvx') && entry.distribution.uvx
        ? { bin: 'uvx', spec: entry.distribution.uvx, args: [] }
        : undefined;
  if (!choice) {
    if (entry.distribution.binary && !entry.distribution.npx && !entry.distribution.uvx)
      throw new Error(
        'That agent is installed as a download; install it, then use --acp "<its command>"',
      );
    throw new Error('Install npx or uvx to run that ACP agent, or use --acp "<its command>".');
  }
  return {
    version: entry.version,
    agent: {
      id: uniqueId(entry.name, used),
      label: entry.name.slice(0, 60),
      kind: 'acp',
      command: choice.bin,
      args: [...choice.args, choice.spec.package, ...(choice.spec.args ?? [])],
      cwd,
      ...(choice.spec.env ? { env: choice.spec.env } : {}),
    },
  };
}
