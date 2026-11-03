import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { systemSpawn, type ChildLike } from './process';

/**
 * The real process layer: Windows `.cmd` shims (npm installs) and killing an agent's whole process
 * tree when a call ends or the connector stops, so nothing is left running on the user's computer.
 */

const dirs: string[] = [];
const children: ChildLike[] = [];
const originalPath = process.env.PATH;
afterEach(async () => {
  for (const child of children.splice(0)) child.killTree();
  process.env.PATH = originalPath;
  // Windows keeps a folder busy for a moment after a process that ran in it is killed.
  await Promise.all(
    dirs
      .splice(0)
      .map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

async function tempDir(name = 'cord-connect-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), name));
  dirs.push(dir);
  return dir;
}

function output(child: ChildLike): Promise<{ stdout: string; code: number | null }> {
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.resume();
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve({ stdout, code }));
    child.once('error', () => resolve({ stdout, code: -1 }));
  });
}

function firstLine(child: ChildLike): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      const newline = text.indexOf('\n');
      if (newline >= 0) resolve(text.slice(0, newline).trim());
    });
    child.once('exit', () => reject(new Error(`exited before a line: ${text}`)));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/** A parent that starts a long-lived grandchild and prints its pid. */
const PARENT = `
const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
console.log(grandchild.pid);
setTimeout(() => {}, 60000);
`;

describe('systemSpawn', () => {
  it.runIf(process.platform === 'win32')(
    'starts an npm .cmd shim that lives in a folder with a space (Windows)',
    async () => {
      const dir = join(await tempDir(), 'John Smith', 'npm');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'fake-agent.cmd'), '@echo off\r\necho ready %1\r\n', 'utf8');
      process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`;
      const child = systemSpawn({ command: 'fake-agent', args: ['--acp'], cwd: dir });
      children.push(child);
      const { stdout, code } = await output(child);
      expect(stdout.trim()).toBe('ready --acp');
      expect(code).toBe(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'refuses shell metacharacters in arguments to a .cmd shim (Windows)',
    async () => {
      const dir = await tempDir();
      await writeFile(join(dir, 'fake-agent.cmd'), '@echo off\r\necho ran\r\n', 'utf8');
      process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`;
      for (const arg of ['a"b', '%PATH%', 'x\ny']) {
        expect(() => systemSpawn({ command: 'fake-agent', args: [arg], cwd: dir })).toThrow();
      }
      // Spaces and cmd operators are quoted, so they reach the shim as plain text.
      const child = systemSpawn({ command: 'fake-agent', args: ['a & echo pwned'], cwd: dir });
      children.push(child);
      const { stdout } = await output(child);
      expect(stdout).not.toContain('pwned');
    },
  );

  it('killTree stops the agent and every process it started', async () => {
    const dir = await tempDir();
    const script = join(dir, 'parent.cjs');
    await writeFile(script, PARENT, 'utf8');
    const child = systemSpawn({ command: process.execPath, args: [script], cwd: dir });
    children.push(child);
    const grandchild = Number(await firstLine(child));
    expect(alive(grandchild)).toBe(true);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.killTree();
    await exited;
    expect(await gone(grandchild)).toBe(true);
  });

  it('killTree after the process exited is a no-op', async () => {
    const dir = await tempDir();
    const child = systemSpawn({ command: process.execPath, args: ['-e', ''], cwd: dir });
    await output(child);
    expect(() => child.killTree()).not.toThrow();
    expect(() => child.killTree()).not.toThrow();
  });
});
