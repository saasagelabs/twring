import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LocalAgentConfig } from './agents';
import { SKILL_FILES } from './skill-files';
import {
  installSkill,
  refreshInstalledSkills,
  skillLines,
  skillTargets,
  type SkillTarget,
} from './skill-install';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'twring-skill-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function agent(kind: LocalAgentConfig['kind'], label: string, command = label): LocalAgentConfig {
  return {
    id: label.toLowerCase().replace(/\W+/g, '-'),
    label,
    kind,
    command,
    args: [],
    cwd: home,
  };
}

function target(dir = join(home, 'skills', 'twring')): SkillTarget {
  return { agentLabels: ['Claude Code'], dir };
}

async function filePaths(dir: string, prefix = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await filePaths(dir, path)));
    else paths.push(path);
  }
  return paths.sort();
}

describe('skillTargets', () => {
  it('maps supported agents, including both Hermes command path styles', () => {
    const agents = [
      agent('claude-code', 'Claude Code'),
      agent('codex', 'Codex'),
      agent('acp', 'Hermes', '/usr/local/bin/hermes'),
      agent('acp', 'Hermes Windows', 'C:\\x\\Hermes.EXE'),
      agent('acp', 'Gemini', 'gemini'),
      agent('command', 'Custom'),
    ];
    expect(skillTargets(agents, {}, home)).toEqual([
      { agentLabels: ['Claude Code'], dir: join(home, '.claude', 'skills', 'twring') },
      { agentLabels: ['Codex'], dir: join(home, '.codex', 'skills', 'twring') },
      {
        agentLabels: ['Hermes', 'Hermes Windows'],
        dir: join(home, '.hermes', 'skills', 'twring'),
      },
    ]);
  });

  it('uses nonempty environment overrides and falls back for empty values', () => {
    const agents = [
      agent('claude-code', 'Claude'),
      agent('codex', 'Codex'),
      agent('acp', 'Hermes', 'hermes.cmd'),
    ];
    expect(
      skillTargets(
        agents,
        {
          CLAUDE_CONFIG_DIR: join(home, 'custom-claude'),
          CODEX_HOME: join(home, 'custom-codex'),
          HERMES_HOME: join(home, 'custom-hermes'),
        },
        home,
      ).map((entry) => entry.dir),
    ).toEqual(
      ['custom-claude', 'custom-codex', 'custom-hermes'].map((name) =>
        join(home, name, 'skills', 'twring'),
      ),
    );
    expect(
      skillTargets(agents, { CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', HERMES_HOME: '' }, home).map(
        (entry) => entry.dir,
      ),
    ).toEqual(['.claude', '.codex', '.hermes'].map((name) => join(home, name, 'skills', 'twring')));
  });

  it('deduplicates two agents using one folder and retains label order', () => {
    expect(
      skillTargets([agent('claude-code', 'First'), agent('claude-code', 'Second')], {}, home),
    ).toEqual([
      { agentLabels: ['First', 'Second'], dir: join(home, '.claude', 'skills', 'twring') },
    ]);
  });
});

describe('installSkill', () => {
  it('installs exactly the embedded files with identical content', async () => {
    const selected = target();
    expect(await installSkill(selected)).toEqual({ status: 'installed', target: selected });
    expect(await filePaths(selected.dir)).toEqual(SKILL_FILES.map((file) => file.path).sort());
    for (const file of SKILL_FILES) {
      expect(await readFile(join(selected.dir, file.path), 'utf8')).toBe(file.content);
    }
  });

  it('does not write on a repeated install', async () => {
    const selected = target();
    await installSkill(selected);
    const mtimes = await Promise.all(
      SKILL_FILES.map((file) => stat(join(selected.dir, file.path))),
    );
    expect(await installSkill(selected)).toEqual({ status: 'unchanged', target: selected });
    expect(
      await Promise.all(
        SKILL_FILES.map(async (file) => (await stat(join(selected.dir, file.path))).mtimeMs),
      ),
    ).toEqual(mtimes.map((entry) => entry.mtimeMs));
  });

  it('replaces older content and removes stale files without leaving siblings', async () => {
    const selected = target();
    await mkdir(selected.dir, { recursive: true });
    await writeFile(join(selected.dir, 'SKILL.md'), '---\nname: twring\n---\nold');
    await writeFile(join(selected.dir, 'stale.md'), 'stale');
    expect(await installSkill(selected)).toEqual({ status: 'updated', target: selected });
    expect(await filePaths(selected.dir)).toEqual(SKILL_FILES.map((file) => file.path).sort());
    for (const file of SKILL_FILES) {
      expect(await readFile(join(selected.dir, file.path), 'utf8')).toBe(file.content);
    }
    expect(
      (await readdir(join(home, 'skills'))).filter((name) => /\.tmp-|\.old-/.test(name)),
    ).toEqual([]);
  });

  it('refreshing brings an installed Twring skill up to date, and never adds one', async () => {
    const installed = target(join(home, 'a', 'skills', 'twring'));
    await installSkill(installed, [{ path: 'SKILL.md', content: '---\nname: twring\n---\nold\n' }]);
    expect(await installSkill(installed, SKILL_FILES, { onlyIfPresent: true })).toEqual({
      status: 'updated',
      target: installed,
    });
    expect(await readFile(join(installed.dir, 'SKILL.md'), 'utf8')).toBe(SKILL_FILES[0]!.content);
    const absent = target(join(home, 'b', 'skills', 'twring'));
    expect(await installSkill(absent, SKILL_FILES, { onlyIfPresent: true })).toEqual({
      status: 'skipped',
      target: absent,
      reason: 'absent',
    });
    await expect(stat(absent.dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refreshing keeps a copy of the same or a newer version, even one the owner edited', async () => {
    const edited = target(join(home, 'c', 'skills', 'twring'));
    const version = /\n {2}version: (\S+)\n/.exec(SKILL_FILES[0]!.content)![1]!;
    const mine = `---\nname: twring\nmetadata:\n  version: ${version}\n---\nmy own notes\n`;
    await installSkill(edited, [{ path: 'SKILL.md', content: mine }]);
    expect(await installSkill(edited, SKILL_FILES, { onlyIfPresent: true })).toEqual({
      status: 'unchanged',
      target: edited,
    });
    expect(await readFile(join(edited.dir, 'SKILL.md'), 'utf8')).toBe(mine);
  });

  it('refreshing leaves a linked skill folder to whoever linked it, without a word', async () => {
    const real = join(home, 'real-twring');
    await installSkill(target(real), [
      { path: 'SKILL.md', content: '---\nname: twring\n---\nold\n' },
    ]);
    const linked = target(join(home, 'd', 'skills', 'twring'));
    await mkdir(join(home, 'd', 'skills'), { recursive: true });
    await symlink(real, linked.dir, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await installSkill(linked, SKILL_FILES, { onlyIfPresent: true });
    expect(result).toEqual({ status: 'skipped', target: linked, reason: 'linked' });
    expect(skillLines([result], home)).toEqual([]);
  });

  it('a refresh that fails says the skill could not be updated', () => {
    const selected = target();
    expect(
      skillLines(
        [{ status: 'failed', target: selected, message: 'EPERM', updating: true }],
        home,
      )[0],
    ).toMatch(/^Could not update the Twring skill for Claude Code/);
  });

  it('refreshes each agent that already has the skill when the computer tool starts', async () => {
    const env = { CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex') };
    const agents = [
      agent('claude-code', 'Claude Code', 'claude'),
      agent('codex', 'Codex', 'codex'),
    ];
    const claude = join(home, 'claude', 'skills', 'twring');
    await installSkill({ agentLabels: ['Claude Code'], dir: claude }, [
      { path: 'SKILL.md', content: '---\nname: twring\n---\nold\n' },
    ]);
    const results = await refreshInstalledSkills(agents, env, home);
    expect(results.map((r) => [r.target.agentLabels.join(), r.status])).toEqual([
      ['Claude Code', 'updated'],
      ['Codex', 'skipped'],
    ]);
  });

  it('leaves a foreign or manifestless folder untouched', async () => {
    for (const [name, manifest] of [
      ['foreign', '---\nname: other\n---\n'],
      ['missing', undefined],
    ] as const) {
      const selected = target(join(home, name, 'twring'));
      await mkdir(selected.dir, { recursive: true });
      await writeFile(join(selected.dir, 'sentinel.bin'), Buffer.from([0, 255, 1]));
      if (manifest !== undefined) await writeFile(join(selected.dir, 'SKILL.md'), manifest);
      const before = await Promise.all(
        (await filePaths(selected.dir)).map(async (path) => ({
          path,
          content: await readFile(join(selected.dir, path)),
          mtimeMs: (await stat(join(selected.dir, path))).mtimeMs,
        })),
      );
      expect(await installSkill(selected)).toEqual({
        status: 'skipped',
        target: selected,
        reason: 'not_ours',
      });
      const after = await Promise.all(
        (await filePaths(selected.dir)).map(async (path) => ({
          path,
          content: await readFile(join(selected.dir, path)),
          mtimeMs: (await stat(join(selected.dir, path))).mtimeMs,
        })),
      );
      expect(after).toEqual(before);
    }
  });

  it('returns failed when the parent is a file and leaves no temp folder', async () => {
    const parent = join(home, 'blocked');
    await writeFile(parent, 'keep');
    const selected = target(join(parent, 'twring'));
    const result = await installSkill(selected);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toMatch(/\S/);
    expect(await readdir(home)).toEqual(['blocked']);
    expect(await readFile(parent, 'utf8')).toBe('keep');
  });
});

it('formats a line for each visible status', () => {
  const selected = { agentLabels: ['Claude Code', 'Codex'], dir: join(home, 'skills', 'twring') };
  const shown = join('~', 'skills', 'twring');
  expect(
    skillLines(
      [
        { status: 'installed', target: selected },
        { status: 'updated', target: selected },
        { status: 'unchanged', target: selected },
        { status: 'skipped', target: selected, reason: 'not_ours' },
        { status: 'skipped', target: selected, reason: 'absent' },
        { status: 'failed', target: selected, message: 'permission denied' },
      ],
      home,
    ),
  ).toEqual([
    `Added the Twring skill for Claude Code and Codex (${shown}).`,
    `Updated the Twring skill for Claude Code and Codex (${shown}).`,
    `Left ${shown} alone: it is not the Twring skill.`,
    `Could not add the Twring skill for Claude Code and Codex (${shown}): permission denied`,
  ]);
});

it('embeds every source skill file with normalized line endings', async () => {
  const source = fileURLToPath(new URL('../../../skills/twring/', import.meta.url));
  const paths = await filePaths(source);
  expect(SKILL_FILES.map((file) => file.path)).toEqual(paths);
  for (const file of SKILL_FILES) {
    const path = join(source, ...file.path.split('/'));
    expect(relative(source, path).split(sep).join('/')).toBe(file.path);
    expect(file.content).toBe((await readFile(path, 'utf8')).replace(/\r/g, ''));
  }
});
