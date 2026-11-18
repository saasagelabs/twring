import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  CONNECTOR_CLI_NAME,
  sanitizeRingText,
  sessionRefSchema,
  truncateRingText,
} from '@twring/contracts';
import { z } from 'zod';

import { posixQuote } from './preamble';

/**
 * Lets coding agents ring their owner by themselves (ADR-024).
 *
 * - Claude Code: a `Notification` hook in `~/.claude/settings.json`. Claude Code runs it when it
 *   needs permission or has waited for input, with JSON on stdin: `session_id`, `transcript_path`,
 *   `cwd`, `hook_event_name: "Notification"`, `message`
 *   (https://docs.claude.com/en/docs/claude-code/hooks).
 * - Codex: `notify` in `~/.codex/config.toml`. Codex runs that program after each turn with one
 *   JSON argument: `type: "agent-turn-complete"`, `thread-id`, `turn-id`, `cwd`,
 *   `input-messages`, `last-assistant-message`
 *   (https://github.com/openai/codex/blob/main/docs/config.md#notify). Off unless asked for, since
 *   it fires after every turn.
 */

export type HookSource = 'claude' | 'codex';

export interface HookRing {
  /** At most 140 characters, for a ring. */
  reason: string;
  /** The agent's full words, for a message. */
  text: string;
  sessionRef?: string;
}

const claudeHookSchema = z
  .object({
    session_id: z.string().optional(),
    hook_event_name: z.string().optional(),
    message: z.string().optional(),
  })
  .loose();

const codexNotifySchema = z
  .object({
    type: z.string(),
    'thread-id': z.string().optional(),
    'last-assistant-message': z.string().nullable().optional(),
  })
  .loose();

function reasonFrom(text: string | null | undefined, fallback: string): string {
  const clean = sanitizeRingText(text ?? '');
  if (clean === '') return fallback;
  return truncateRingText(clean, 140, '…');
}

function sessionRef(value: string | undefined): string | undefined {
  return value !== undefined && sessionRefSchema.safeParse(value).success ? value : undefined;
}

/**
 * The ring a hook's JSON asks for, or undefined when there is nothing to ring about (not JSON, or
 * an event other than a Claude notification or a finished Codex turn).
 */
export function parseHookInput(source: HookSource, raw: string): HookRing | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (source === 'claude') {
    const input = claudeHookSchema.safeParse(json);
    if (!input.success) return undefined;
    const event = input.data.hook_event_name;
    if (event !== undefined && event !== 'Notification') return undefined;
    const ref = sessionRef(input.data.session_id);
    return {
      reason: reasonFrom(input.data.message, 'Claude Code is waiting for you'),
      text: input.data.message?.trim() || 'Claude Code is waiting for you',
      ...(ref !== undefined && { sessionRef: ref }),
    };
  }
  const input = codexNotifySchema.safeParse(json);
  if (!input.success || input.data.type !== 'agent-turn-complete') return undefined;
  const ref = sessionRef(input.data['thread-id']);
  return {
    reason: reasonFrom(input.data['last-assistant-message'], 'Codex finished a turn'),
    text: input.data['last-assistant-message']?.trim() || 'Codex finished a turn',
    ...(ref !== undefined && { sessionRef: ref }),
  };
}

/**
 * What a hook runs: this computer's Node and the connector copy kept in the config folder. Never
 * `npx`: the connector is not on npm, so `npx` would fetch whatever package holds its name.
 */
export interface HookTarget {
  /** Absolute path of the Node binary. */
  node: string;
  /** Node flags needed to run `script` again (a TypeScript loader when run from source). */
  nodeArgs?: readonly string[];
  /** Absolute path of the connector script. */
  script: string;
}

function hookArgv(target: HookTarget, mode: 'ring' | 'message', source: HookSource): string[] {
  return [target.node, ...(target.nodeArgs ?? []), target.script, mode, '--from-hook', source];
}

/**
 * The shell command a Claude Code hook runs. Claude Code runs hooks with bash (Git Bash on
 * Windows), so Windows paths get forward slashes, which bash and Windows both take.
 */
export function hookCommand(
  source: HookSource,
  mode: 'ring' | 'message',
  target: HookTarget,
): string {
  return hookArgv(target, mode, source)
    .map((arg) => posixQuote(arg.replace(/\\/g, '/')))
    .join(' ');
}
const LEGACY_CLI_NAME = 'cord-connect';
/**
 * Recognises a Twring hook command, whichever way it was written: `npx twring-connect ring
 * --from-hook claude` (before), or `/usr/bin/node '/home/me/.../cord-connect.mjs' ring --from-hook
 * claude` (now).
 */
const OUR_HOOK = new RegExp(
  `(?:${CONNECTOR_CLI_NAME}|${LEGACY_CLI_NAME})(?:\\.[cm]?[jt]s)?'?\\s+(?:ring|message)\\s+--from-hook\\b`,
);

export function claudeSettingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

export function codexConfigPath(home: string): string {
  return join(home, '.codex', 'config.toml');
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Copies `path` next to itself before the first change, so the user can undo by hand. */
async function backUp(path: string): Promise<string> {
  const backup = `${path}.cord-backup`;
  await copyFile(path, backup);
  return backup;
}

async function writeWithDir(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface ClaudeMatcher {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

function hasCommand(group: unknown, test: (command: string) => boolean): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
  return (group as ClaudeMatcher).hooks!.some(
    (h) => isRecord(h) && typeof h.command === 'string' && test(h.command),
  );
}

const isOurs = (group: unknown): boolean => hasCommand(group, (command) => OUR_HOOK.test(command));

/** Result lines describing exactly what changed (or that nothing did). */
export type HookChange = string[];

export async function installClaudeHook(
  home: string,
  mode: 'ring' | 'message',
  target: HookTarget,
): Promise<HookChange> {
  const path = claudeSettingsPath(home);
  const text = await readText(path);
  let settings: Json = {};
  if (text !== undefined && text.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${path} is not valid JSON; fix it first. Nothing was changed.`);
    }
    if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object. Nothing was changed.`);
    settings = parsed;
  }
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const notification = Array.isArray(hooks.Notification) ? (hooks.Notification as unknown[]) : [];
  // Already exactly this hook, and no other Twring hook (another mode, an old npx one) left over.
  const wanted = hookCommand('claude', mode, target);
  const ours = notification.filter(isOurs);
  if (ours.length === 1 && hasCommand(ours[0], (command) => command === wanted)) {
    return [`Already installed in ${path}. Nothing changed.`];
  }
  const changes: string[] = [];
  if (text !== undefined) changes.push(`Backed up ${path} to ${await backUp(path)}.`);
  const next: Json = {
    ...settings,
    hooks: {
      ...hooks,
      Notification: [
        ...notification.filter((group) => !isOurs(group)),
        { matcher: '', hooks: [{ type: 'command', command: wanted }] },
      ],
    },
  };
  await writeWithDir(path, `${JSON.stringify(next, null, 2)}\n`);
  changes.push(`Added a Notification hook to ${path}: ${wanted}`);
  return changes;
}

export async function uninstallClaudeHook(home: string): Promise<HookChange> {
  const path = claudeSettingsPath(home);
  const text = await readText(path);
  if (text === undefined) return [`${path} does not exist. Nothing changed.`];
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON; fix it first. Nothing was changed.`);
  }
  if (!isRecord(settings) || !isRecord(settings.hooks)) {
    return [`No Twring hook in ${path}. Nothing changed.`];
  }
  const hooks = settings.hooks;
  const notification = Array.isArray(hooks.Notification) ? (hooks.Notification as unknown[]) : [];
  const kept = notification.filter((group) => !isOurs(group));
  if (kept.length === notification.length) return [`No Twring hook in ${path}. Nothing changed.`];
  const backup = await backUp(path);
  const nextHooks: Json = { ...hooks };
  if (kept.length > 0) nextHooks.Notification = kept;
  else delete nextHooks.Notification;
  const next: Json = { ...settings };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  return [`Backed up ${path} to ${backup}.`, `Removed the Twring Notification hook from ${path}.`];
}

function codexNotifyLine(mode: 'ring' | 'message', target: HookTarget): string {
  // Codex runs notify as a program with arguments, not through a shell: no quoting needed.
  const argv = hookArgv(target, mode, 'codex');
  return `notify = [${argv.map((a) => JSON.stringify(a)).join(', ')}]`;
}

const BOM = String.fromCharCode(0xfeff);

const isOurNotify = (line: string): boolean =>
  (line.includes(CONNECTOR_CLI_NAME) || line.includes(LEGACY_CLI_NAME)) &&
  line.includes('--from-hook') &&
  (line.includes('"ring"') || line.includes('"message"'));

/**
 * For each line, whether it starts outside any multi-line string or array, so a line that begins
 * with `[` or `notify =` inside one (a prompt, a list) is not taken for a table header or a key.
 * A light scan, not a TOML parser: enough to never edit inside a value.
 */
function structuralLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let inString: '"""' | "'''" | undefined;
  let depth = 0;
  for (const line of lines) {
    const structural = inString === undefined && depth === 0;
    out.push(structural);
    if (structural && line.trim().startsWith('[')) continue; // A table header.
    let i = 0;
    while (i < line.length) {
      if (inString !== undefined) {
        const end = line.indexOf(inString, i);
        if (end < 0) break;
        inString = undefined;
        i = end + 3;
        continue;
      }
      const ch = line[i];
      if (ch === '#') break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        inString = line.startsWith('"""', i) ? '"""' : "'''";
        i += 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += ch === '"' && line[j] === '\\' ? 2 : 1;
        i = j + 1;
        continue;
      }
      if (ch === '[') depth += 1;
      else if (ch === ']') depth = Math.max(0, depth - 1);
      i += 1;
    }
  }
  return out;
}

/** A top-level `notify = …` line (before the first table header), with its index. */
function findNotify(lines: string[]): number {
  const structural = structuralLines(lines);
  for (let i = 0; i < lines.length; i += 1) {
    if (!structural[i]) continue;
    const line = lines[i]!.trim();
    if (line.startsWith('[')) return -1;
    if (/^notify\s*=/.test(line)) return i;
  }
  return -1;
}

/** Why `hooks install codex` without --on-turn-complete changes nothing. */
export const CODEX_OFF: readonly string[] = [
  'Codex can only ring after every finished turn, which gets noisy, so it is off by default.',
  'To turn it on, run hooks install codex again with --on-turn-complete.',
];

export async function installCodexNotify(
  home: string,
  onTurnComplete: boolean,
  mode: 'ring' | 'message',
  target: HookTarget,
): Promise<HookChange> {
  const path = codexConfigPath(home);
  if (!onTurnComplete) return [...CODEX_OFF];
  const text = await readText(path);
  const eol = text?.includes('\r\n') === true ? '\r\n' : '\n';
  const lines = text === undefined || text === '' ? [] : text.split(/\r?\n/);
  const at = findNotify(lines);
  if (at >= 0) {
    if (isOurNotify(lines[at]!)) {
      if (lines[at]!.replace(BOM, '') === codexNotifyLine(mode, target)) {
        return [`Already installed in ${path}. Nothing changed.`];
      }
      const backup = await backUp(path);
      const bom = lines[at]!.startsWith(BOM) ? BOM : '';
      lines[at] = `${bom}${codexNotifyLine(mode, target)}`;
      await writeFile(path, lines.join(eol));
      return [
        `Backed up ${path} to ${backup}.`,
        `Set notify in ${path}: ${codexNotifyLine(mode, target)}`,
      ];
    }
    throw new Error(
      `${path} already sets notify to another program. Remove that line first; nothing was changed.`,
    );
  }
  const changes: string[] = [];
  if (text !== undefined) changes.push(`Backed up ${path} to ${await backUp(path)}.`);
  // Top-level keys must come before the first [table]; the very top of the file always is, and is
  // never inside a multi-line value.
  const bom = lines[0]?.startsWith(BOM) === true;
  if (bom) lines[0] = lines[0]!.slice(1);
  const next = [`${bom ? BOM : ''}${codexNotifyLine(mode, target)}`, ...lines];
  let out = next.join(eol);
  if (!out.endsWith(eol)) out += eol;
  await writeWithDir(path, out);
  changes.push(`Set notify in ${path}: ${codexNotifyLine(mode, target)}`);
  return changes;
}

export async function uninstallCodexNotify(home: string): Promise<HookChange> {
  const path = codexConfigPath(home);
  const text = await readText(path);
  if (text === undefined) return [`${path} does not exist. Nothing changed.`];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = findNotify(lines);
  if (at < 0 || !isOurNotify(lines[at]!)) {
    return [`No Twring notify in ${path}. Nothing changed.`];
  }
  const backup = await backUp(path);
  const [removed] = lines.splice(at, 1);
  // Our line went on top of the file, in front of any byte-order mark: keep the mark.
  if (removed?.startsWith(BOM) === true && lines.length > 0) lines[0] = `${BOM}${lines[0]!}`;
  await writeFile(path, lines.join(eol));
  return [`Backed up ${path} to ${backup}.`, `Removed the Twring notify line from ${path}.`];
}
