import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import type { LocalAgentConfig } from './agents';
import { SKILL_FILES, SKILL_NAME } from './skill-files';

export interface SkillTarget {
  agentLabels: string[];
  dir: string;
}

export function skillTargets(
  agents: readonly LocalAgentConfig[],
  env: NodeJS.ProcessEnv,
  home: string,
): SkillTarget[] {
  const targets: SkillTarget[] = [];
  for (const agent of agents) {
    let base: string | undefined;
    if (agent.kind === 'claude-code') base = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    else if (agent.kind === 'codex') base = env.CODEX_HOME || join(home, '.codex');
    else if (agent.kind === 'acp') {
      const commandName = basename(agent.command.replace(/\\/g, '/'))
        .replace(/\.(exe|cmd|bat)$/i, '')
        .toLowerCase();
      if (commandName === 'hermes') base = env.HERMES_HOME || join(home, '.hermes');
    }
    if (base === undefined) continue;
    const dir = join(base, 'skills', SKILL_NAME);
    const existing = targets.find((target) => target.dir === dir);
    if (existing) existing.agentLabels.push(agent.label);
    else targets.push({ agentLabels: [agent.label], dir });
  }
  return targets;
}

export type SkillResult =
  | { status: 'installed' | 'updated' | 'unchanged'; target: SkillTarget }
  | { status: 'skipped'; target: SkillTarget; reason: 'not_ours' | 'absent' | 'linked' }
  | { status: 'failed'; target: SkillTarget; message: string; updating?: boolean };

async function existingPath(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isOurs(content: string): boolean {
  const lines = content.replace(/\r/g, '').split('\n');
  if (lines[0] !== '---') return false;
  const end = lines.indexOf('---', 1);
  return end > 1 && lines.slice(1, end).includes(`name: ${SKILL_NAME}`);
}

/** The `version:` in a skill's frontmatter, if any. */
function versionOf(content: string | undefined): string | undefined {
  return content === undefined
    ? undefined
    : /^\s+version:\s*(\S+)\s*$/m.exec(content.replace(/\r/g, ''))?.[1];
}

/** Negative when `a` is older than `b` (numeric parts, so 0.10 is newer than 0.9). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0 || Number.isNaN(diff)) return Number.isNaN(diff) ? -1 : diff;
  }
  return 0;
}

async function listedFiles(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listedFiles(dir, path)));
    else files.push(path);
  }
  return files;
}

export async function installSkill(
  target: SkillTarget,
  files: readonly { path: string; content: string }[] = SKILL_FILES,
  /** Only bring an installed skill up to date; never add one (the owner may have chosen not to). */
  options: { onlyIfPresent?: boolean } = {},
): Promise<SkillResult> {
  let temp: string | undefined;
  let old: string | undefined;
  let movedOld = false;
  let newInPlace = false;
  let exists = false;
  try {
    exists = await existingPath(target.dir);
    if (!exists && options.onlyIfPresent === true)
      return { status: 'skipped', target, reason: 'absent' };
    if (exists) {
      const stat = await lstat(target.dir);
      // A linked folder is managed by whoever linked it; a refresh leaves it be.
      if (options.onlyIfPresent === true && stat.isSymbolicLink())
        return { status: 'skipped', target, reason: 'linked' };
      if (!stat.isDirectory()) throw new Error('Skill path is not a directory.');
      const manifest = await readFile(join(target.dir, 'SKILL.md'), 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (manifest === undefined || !isOurs(manifest)) {
        return { status: 'skipped', target, reason: 'not_ours' };
      }
      // A refresh only replaces an older version: a copy the owner edited keeps their edits.
      const installed = versionOf(manifest);
      const bundled = versionOf(files.find((file) => file.path === 'SKILL.md')?.content);
      if (
        options.onlyIfPresent === true &&
        installed !== undefined &&
        bundled !== undefined &&
        compareVersions(installed, bundled) >= 0
      ) {
        return { status: 'unchanged', target };
      }
      const actual = await listedFiles(target.dir);
      const expected = files.map((file) => file.path);
      if (
        actual.length === expected.length &&
        actual.every((path) => expected.includes(path)) &&
        (
          await Promise.all(
            files.map(
              async (file) =>
                (await readFile(join(target.dir, file.path), 'utf8')) === file.content,
            ),
          )
        ).every(Boolean)
      ) {
        return { status: 'unchanged', target };
      }
    }

    const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    temp = `${target.dir}.tmp-${suffix}`;
    old = `${target.dir}.old-${suffix}`;
    await mkdir(temp, { recursive: true });
    for (const file of files) {
      const destination = join(temp, file.path);
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, file.content);
    }
    if (exists) {
      await rename(target.dir, old);
      movedOld = true;
    }
    await rename(temp, target.dir);
    newInPlace = true;
    if (movedOld) await rm(old, { recursive: true, force: true });
    return { status: exists ? 'updated' : 'installed', target };
  } catch (error) {
    if (temp !== undefined) {
      try {
        await rm(temp, { recursive: true, force: true });
      } catch {
        // Keep the original error for the result.
      }
    }
    if (movedOld && !newInPlace && old !== undefined) {
      try {
        await rename(old, target.dir);
      } catch {
        // Keep the original error for the result.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      target,
      message: message.replace(/\s+/g, ' ').trim(),
      ...(exists && { updating: true }),
    };
  }
}

export function skillLines(results: readonly SkillResult[], home: string): string[] {
  const show = (dir: string) => {
    const within = relative(home, dir);
    return within === ''
      ? '~'
      : !within.startsWith('..') && !within.startsWith(sep)
        ? join('~', within)
        : dir;
  };
  return results.flatMap((result) => {
    if (result.status === 'unchanged') return [];
    if (result.status === 'skipped' && result.reason !== 'not_ours') return [];
    const dir = show(result.target.dir);
    if (result.status === 'skipped') return [`Left ${dir} alone: it is not the Twring skill.`];
    const labels = result.target.agentLabels.join(' and ');
    if (result.status === 'failed') {
      const verb = result.updating === true ? 'update' : 'add';
      return [`Could not ${verb} the Twring skill for ${labels} (${dir}): ${result.message}`];
    }
    return [
      `${result.status === 'updated' ? 'Updated' : 'Added'} the Twring skill for ${labels} (${dir}).`,
    ];
  });
}

/**
 * Brings the Twring skill up to date for every agent that already has it: each start of the
 * computer tool carries the skill it was built with, so updating the tool updates the skill.
 */
export async function refreshInstalledSkills(
  agents: readonly LocalAgentConfig[],
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<SkillResult[]> {
  const results: SkillResult[] = [];
  for (const target of skillTargets(agents, env, home)) {
    results.push(await installSkill(target, SKILL_FILES, { onlyIfPresent: true }));
  }
  return results;
}
