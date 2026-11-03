import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sessionRefSchema } from '@twring/contracts';

import { configDir } from './config';
import type { LocalAgentAdapter } from './events';

export const IDLE_CLOSE_MS = 30 * 60_000;
/** Saved session ids remembered per pool key, so a person can go back to an older conversation. */
export const SESSION_HISTORY_SIZE = 20;

interface Entry {
  adapter: LocalAgentAdapter;
  holders: number;
  running: number;
  previous: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  idleExpired: boolean;
  retired: boolean;
  pendingReset: boolean;
}

export interface AgentPoolOptions {
  createAdapter(agentId: string, resumeRef?: string, scope?: string): LocalAgentAdapter | undefined;
  dir?: string;
  idleCloseMs?: number;
  log?(line: string): void;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // A missing or damaged file is not a reason to stop calls.
  }
  return undefined;
}

/** `sessions.json`: the current session per key (the owner's key is the agent id, unchanged). */
function readRefs(dir: string): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const [key, ref] of Object.entries(readJsonObject(join(dir, 'sessions.json')) ?? {})) {
    if (sessionRefSchema.safeParse(ref).success) refs[key] = ref as string;
  }
  return refs;
}

/** `session-history.json`: the last sessions saved per key, oldest first. Absent for old installs. */
function readHistory(dir: string): Record<string, string[]> {
  const history: Record<string, string[]> = {};
  for (const [key, refs] of Object.entries(
    readJsonObject(join(dir, 'session-history.json')) ?? {},
  )) {
    if (!Array.isArray(refs)) continue;
    const valid = refs.filter((ref): ref is string => sessionRefSchema.safeParse(ref).success);
    if (valid.length > 0) history[key] = valid.slice(-SESSION_HISTORY_SIZE);
  }
  return history;
}

function scopeOfKey(key: string): string | undefined {
  const hash = key.indexOf('#');
  return hash > 0 ? key.slice(hash + 1) : undefined;
}

/**
 * The team member's scope a saved session belongs to (current or in that person's history), or
 * undefined for the owner's own or an unknown session. The CLI uses it to refuse an unscoped ring
 * into a member's session.
 */
export function scopeOfSessionRef(dir: string, ref: string): string | undefined {
  const refs = readRefs(dir);
  const history = readHistory(dir);
  for (const key of new Set([...Object.keys(refs), ...Object.keys(history)])) {
    const scope = scopeOfKey(key);
    if (scope !== undefined && (refs[key] === ref || history[key]?.includes(ref))) return scope;
  }
  return undefined;
}

/**
 * The pool key: the local agent, plus the person's scope for someone other than the owner on a
 * shared server agent. The owner's key (no scope) is exactly the agent id, as before.
 */
function keyOf(agentId: string, scope?: string): string {
  return scope === undefined ? agentId : `${agentId}#${scope}`;
}

/** One live adapter and one ordered turn queue per local agent (and person scope). */
export class AgentPool {
  private readonly entries = new Map<string, Entry>();
  private readonly refs: Record<string, string>;
  private readonly history: Record<string, string[]>;
  private readonly dir: string;
  private closed = false;

  constructor(private readonly options: AgentPoolOptions) {
    this.dir = options.dir ?? configDir();
    this.refs = readRefs(this.dir);
    this.history = readHistory(this.dir);
  }

  /**
   * Whether this acquire may resume `ref`. A team member resumes only a session this pool saved
   * under their own key (current or history) or the one their live adapter is running right now
   * (a ring answered during its first turn). The owner resumes anything except a member's
   * sessions, so rings from the owner's own terminal sessions keep working.
   */
  private mayResume(key: string, scope: string | undefined, ref: string): boolean {
    if (scope !== undefined) {
      return (
        this.refs[key] === ref ||
        this.history[key]?.includes(ref) === true ||
        this.entries.get(key)?.adapter.sessionRef?.() === ref
      );
    }
    for (const other of new Set([...Object.keys(this.refs), ...Object.keys(this.history)])) {
      if (scopeOfKey(other) === undefined) continue;
      if (this.refs[other] === ref || this.history[other]?.includes(ref) === true) return false;
    }
    return true;
  }

  acquire(
    agentId: string,
    resumeRef?: string,
    freshSession = false,
    scope?: string,
  ): LocalAgentAdapter | undefined {
    if (this.closed) return undefined;
    const key = keyOf(agentId, scope);
    if (resumeRef !== undefined && !this.mayResume(key, scope, resumeRef)) {
      this.options.log?.('a session saved for someone else was not resumed');
      resumeRef = undefined;
    }
    let entry = this.entries.get(key);
    if (freshSession) {
      delete this.refs[key];
      this.persistRefs();
      if (entry !== undefined) {
        entry.retired = true;
        entry.pendingReset = true;
      }
      resumeRef = undefined;
    }
    if (entry !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.idleExpired = false;
      if (entry.pendingReset && entry.running === 0 && entry.holders === 0) {
        this.drop(key, entry);
        entry = undefined;
        resumeRef = undefined;
      } else if (
        resumeRef !== undefined &&
        resumeRef !== entry.adapter.sessionRef?.() &&
        entry.running === 0 &&
        entry.holders === 0
      ) {
        entry.adapter.close();
        this.entries.delete(key);
        entry = undefined;
      }
    }
    if (entry === undefined) {
      const adapter = this.options.createAdapter(agentId, resumeRef ?? this.refs[key], scope);
      if (adapter === undefined) return undefined;
      entry = {
        adapter,
        holders: 0,
        running: 0,
        previous: Promise.resolve(),
        idleExpired: false,
        retired: false,
        pendingReset: false,
      };
      this.entries.set(key, entry);
    }
    entry.holders += 1;
    return entry.adapter;
  }

  release(agentId: string, scope?: string): void {
    const key = keyOf(agentId, scope);
    const entry = this.entries.get(key);
    if (entry === undefined || entry.holders === 0) return;
    entry.holders -= 1;
    if (entry.holders === 0) this.scheduleClose(key, entry);
  }

  runExclusive<T>(agentId: string, fn: () => Promise<T>, scope?: string): Promise<T> {
    const key = keyOf(agentId, scope);
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.reject(new Error(`No adapter for ${agentId}`));
    entry.running += 1;
    const run = entry.previous.then(async () => {
      try {
        return await fn();
      } finally {
        if (!entry.retired) this.saveRef(key, entry.adapter);
        entry.running -= 1;
        if (entry.holders === 0 && entry.idleExpired) this.drop(key, entry);
      }
    });
    entry.previous = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  sessionRef(agentId: string, scope?: string): string | undefined {
    const ref = this.entries.get(keyOf(agentId, scope))?.adapter.sessionRef?.();
    return sessionRefSchema.safeParse(ref).success ? ref : undefined;
  }

  closeAll(): void {
    this.closed = true;
    for (const [agentId, entry] of this.entries) this.drop(agentId, entry);
  }

  private scheduleClose(agentId: string, entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.idleExpired = true;
      if (entry.holders === 0 && entry.running === 0) this.drop(agentId, entry);
    }, this.options.idleCloseMs ?? IDLE_CLOSE_MS);
    entry.timer.unref?.();
  }

  private drop(agentId: string, entry: Entry): void {
    if (this.entries.get(agentId) !== entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(agentId);
    entry.adapter.close();
  }

  private saveRef(agentId: string, adapter: LocalAgentAdapter): void {
    const ref = adapter.sessionRef?.();
    if (!sessionRefSchema.safeParse(ref).success || ref === undefined) return;
    this.refs[agentId] = ref;
    const seen = (this.history[agentId] ?? []).filter((saved) => saved !== ref);
    this.history[agentId] = [...seen, ref].slice(-SESSION_HISTORY_SIZE);
    this.persistRefs();
  }

  private persistRefs(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.writeFile('sessions.json', this.refs);
      this.writeFile('session-history.json', this.history);
    } catch {
      this.options.log?.('could not save agent sessions');
    }
  }

  private writeFile(name: string, value: unknown): void {
    const path = join(this.dir, name);
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
  }
}
