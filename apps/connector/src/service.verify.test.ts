import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { configDir } from './config';
import {
  cronLine,
  CRON_MARKER,
  installScript,
  installService,
  launchdPlist,
  LOG_MAX_BYTES,
  logPath,
  pidPath,
  prepareLog,
  removeRunFiles,
  rotateLog,
  serviceSpecFor,
  statusPath,
  stopRunning,
  systemdUnit,
  waitConnected,
  windowsLauncher,
  withCronLine,
  writePid,
  writeStatus,
  type ExecResult,
  type ServiceHost,
  type ServiceSpec,
} from './service';

const POSIX = process.platform !== 'win32';

/** Verifier edge cases for `cord-connect setup` (ADR-027): escaping, cleanup, pid files, errors. */

const SPEC: ServiceSpec = {
  node: '/usr/local/bin/node',
  script: '/home/ana/my agents/cord-connect.mjs',
  cwd: '/home/ana/my agents',
  env: { PATH: '/usr/bin:/home/ana/.local/bin', HOME: '/home/ana', CORD_CONNECT_SERVICE: '1' },
  logFile: '/home/ana/.config/cord-connect/cord-connect.log',
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(prefix = 'cord-setup-verify-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

interface Call {
  command: string;
  args: string[];
  input?: string;
}

function fakeHost(
  overrides: Partial<ServiceHost> = {},
  answer: (call: Call) => ExecResult = () => ({ status: 0, stdout: '', stderr: '' }),
) {
  const calls: Call[] = [];
  const files = new Map<string, string | Buffer>();
  const host: ServiceHost = {
    platform: 'linux',
    isRoot: false,
    home: '/home/ana',
    uid: 1000,
    user: 'ana',
    windowsUserId: 'PC\\ana',
    exec: (command, args, input) => {
      const call = { command, args, ...(input !== undefined && { input }) };
      calls.push(call);
      return answer(call);
    },
    exists: (path) => files.has(path),
    writeFile: (path, data) => {
      files.set(path, data);
      return Promise.resolve();
    },
    remove: (path) => {
      files.delete(path);
      return Promise.resolve();
    },
    startDetached: () => undefined,
    ...overrides,
  };
  return { host, calls, files };
}

function sleeper(scriptPath?: string) {
  const child = spawn(
    process.execPath,
    scriptPath === undefined ? ['-e', 'setInterval(() => {}, 1000)'] : [scriptPath],
    { stdio: 'ignore' },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  cleanups.push(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  return { child, exited };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('systemd unit text (systemd.exec(5))', () => {
  it('gives WorkingDirectory= the bare path: systemd does not unquote it', () => {
    // A quoted value is not an absolute path to systemd, so the unit fails to load.
    const unit = systemdUnit(SPEC, { system: false });
    expect(unit).toContain('WorkingDirectory=-/home/ana/my agents\n');
    expect(systemdUnit({ ...SPEC, cwd: '/srv/100%' }, { system: true })).toContain(
      'WorkingDirectory=-/srv/100%%\n',
    );
  });

  it('keeps $ literal in Environment= (no variable expansion there)', () => {
    const unit = systemdUnit(
      { ...SPEC, env: { ...SPEC.env, PATH: '/opt/$x/bin:/opt/50%/bin' } },
      { system: false },
    );
    expect(unit).toContain('Environment="PATH=/opt/$x/bin:/opt/50%%/bin"\n');
    // ExecStart= does expand $VAR, so it stays doubled there.
    expect(systemdUnit({ ...SPEC, script: '/a/$HOME/c.mjs' }, { system: false })).toContain(
      '"/a/$$HOME/c.mjs"',
    );
  });

  it('refuses a folder with a leading or trailing space (systemd strips it)', () => {
    expect(() => systemdUnit({ ...SPEC, cwd: '/home/ana/agents ' }, { system: false })).toThrow();
  });

  it('does not restart a service that has no pairing (exit 78)', () => {
    expect(systemdUnit(SPEC, { system: true })).toContain('RestartPreventExitStatus=78\n');
  });
});

describe('crontab', () => {
  it('escapes % (cron turns it into a newline) in every value', () => {
    const line = cronLine({ ...SPEC, cwd: '/srv/100%', env: { ...SPEC.env, PATH: '/a%b' } });
    expect(line).not.toMatch(/(^|[^\\])%/);
    expect(line).toContain("cd '/srv/100\\%'");
    expect(line).toContain("PATH='/a\\%b'");
  });

  it('cannot carry a backslash before % (cron has no way to write it)', () => {
    expect(() => cronLine({ ...SPEC, cwd: '/srv/a\\%b' })).toThrow();
  });

  it("leaves other software's lines, comments and blank lines as they were", () => {
    const theirs = '# backups\n\n0 3 * * * /usr/bin/backup\n\n# end\n';
    const ours = withCronLine(theirs, cronLine(SPEC));
    expect(withCronLine(ours, undefined)).toBe(theirs);
  });

  it('finds its own line after an editor added CRLF or trailing spaces', () => {
    const edited = `0 * * * * x\r\n${cronLine(SPEC)}  \r\n`;
    expect(withCronLine(edited, undefined)).not.toContain(CRON_MARKER);
  });

  it('handles an empty crontab and one with no final newline', () => {
    expect(withCronLine('', cronLine(SPEC))).toBe(`${cronLine(SPEC)}\n`);
    expect(withCronLine('0 * * * * x', cronLine(SPEC))).toBe(`0 * * * * x\n${cronLine(SPEC)}\n`);
    expect(withCronLine('', undefined)).toBe('');
  });

  it('never replaces a crontab it could not read', async () => {
    const fake = fakeHost({}, (call) => {
      if (call.command === 'systemctl') return { status: 1, stdout: '', stderr: '' };
      if (call.command === 'crontab' && call.args[0] === '-l') {
        return {
          status: 1,
          stdout: '',
          stderr: 'crontab: cannot open /var/spool/cron: Permission denied',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const result = await installService(SPEC, fake.host, '/cfg');
    expect(fake.calls.some((c) => c.command === 'crontab' && c.args[0] === '-')).toBe(false);
    expect(result.kind).toBe('background');
  });

  it('writes a first crontab when there is none yet', async () => {
    const fake = fakeHost({}, (call) => {
      if (call.command === 'systemctl') return { status: 1, stdout: '', stderr: '' };
      if (call.command === 'crontab' && call.args[0] === '-l') {
        return { status: 1, stdout: '', stderr: 'no crontab for ana' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const result = await installService(SPEC, fake.host, '/cfg');
    expect(fake.calls.find((c) => c.args[0] === '-')?.input).toBe(`${cronLine(SPEC)}\n`);
    expect(result.kind).toBe('cron');
  });
});

describe('setup errors are one line', () => {
  const failing = (command: string, stderr: string) =>
    fakeHost({}, (call) =>
      call.command === command && call.args.includes('restart')
        ? { status: 1, stdout: '', stderr }
        : { status: 0, stdout: '', stderr: '' },
    );

  it('collapses a multi-line systemctl failure', async () => {
    const fake = failing(
      'systemctl',
      'Job for cord-connect.service failed because the control process exited with error code.\nSee "systemctl --user status cord-connect.service" and "journalctl --user -xeu cord-connect.service" for details.\n',
    );
    const error = await installService(SPEC, fake.host, '/cfg').catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('\n');
    expect((error as Error).message).toMatch(/^Could not start the service: Job for/);
  });

  it('says something when launchctl fails without output', async () => {
    const fake = fakeHost({ platform: 'darwin', home: '/Users/ana', uid: 501 }, (call) =>
      call.args[0] === 'bootstrap' || call.args[0] === 'load'
        ? { status: 5, stdout: '', stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
    );
    const error = await installService(SPEC, fake.host, '/cfg').catch((e: unknown) => e as Error);
    expect((error as Error).message).toMatch(/^Could not start the service: .+/);
  });

  it('says something when schtasks fails without output', async () => {
    const fake = fakeHost({ platform: 'win32' }, (call) =>
      call.args[0] === '/Run'
        ? { status: 1, stdout: '', stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
    );
    const error = await installService(SPEC, fake.host, 'C:\\cfg').catch(
      (e: unknown) => e as Error,
    );
    expect((error as Error).message).toMatch(/^Could not start the task: .+/);
  });
});

describe('pid file', () => {
  it('never stops an unrelated process that reused a stale pid', async () => {
    const dir = await tempDir();
    const { child } = sleeper();
    await writeFile(pidPath(dir), `${child.pid}\n`);
    expect(await stopRunning(dir, { timeoutMs: 500 })).toBe(false);
    expect(isAlive(child.pid!)).toBe(true);
  }, 30_000);
});

describe('waiting for the service to connect', () => {
  it('does not take a connected status from a process that is gone', async () => {
    const dir = await tempDir();
    const since = Date.now();
    const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    await writeStatus(dir, {
      connected: true,
      agents: ['Hermes'],
      at: new Date().toISOString(),
      pid: gone,
    });
    expect(await waitConnected(dir, since, { timeoutMs: 100, intervalMs: 10 })).toBeUndefined();
  });

  it('takes the status of the copy named in the pid file only', async () => {
    const dir = await tempDir();
    const since = Date.now();
    const { child: other } = sleeper();
    const { child: service } = sleeper();
    await writeFile(pidPath(dir), `${service.pid}\n`);
    await writeStatus(dir, {
      connected: true,
      agents: ['Hermes'],
      at: new Date().toISOString(),
      pid: other.pid!,
    });
    expect(await waitConnected(dir, since, { timeoutMs: 100, intervalMs: 10 })).toBeUndefined();
    await writeStatus(dir, {
      connected: true,
      agents: ['Hermes'],
      at: new Date().toISOString(),
      pid: service.pid!,
    });
    expect((await waitConnected(dir, since, { timeoutMs: 1000, intervalMs: 10 }))?.pid).toBe(
      service.pid,
    );
  }, 30_000);
});

describe.runIf(process.platform === 'win32')('the Windows launcher, run for real', () => {
  /** Installs with a host that writes files to disk, then runs the launcher under cscript. */
  async function runLauncher(folderName: string, oldLog?: string) {
    const base = await tempDir('cord-vbs-');
    const cwd = join(base, folderName);
    const configDir = join(base, 'config');
    await mkdir(cwd, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const runs = join(base, 'runs.txt');
    const script = join(cwd, 'cord-connect.mjs');
    // Stands in for the connector: notes each start, prints a line, and exits "not paired".
    await writeFile(
      script,
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(runs)}, 'x');\nconsole.log('started in ' + process.cwd());\nprocess.exit(78);\n`,
    );
    const spec: ServiceSpec = {
      node: process.execPath,
      script,
      cwd,
      env: { PATH: 'C:\\Windows', HOME: base, CORD_CONNECT_SERVICE: '1' },
      logFile: join(configDir, 'cord-connect.log'),
    };
    const fake = fakeHost(
      {
        platform: 'win32',
        writeFile: async (path, data) => {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, data);
        },
        remove: (path) => rm(path, { force: true }),
      },
      () => ({ status: 0, stdout: '', stderr: '' }),
    );
    await installService(spec, fake.host, configDir);
    if (oldLog !== undefined) await writeFile(spec.logFile, oldLog);
    const launcher = join(configDir, 'cord-connect.vbs');
    const result = spawnSync('cscript.exe', ['//B', '//Nologo', launcher], { timeout: 15_000 });
    const previous = `${spec.logFile}.1`;
    return {
      timedOut: result.error !== undefined,
      runs: existsSync(runs) ? (await readFile(runs, 'utf8')).length : 0,
      log: existsSync(spec.logFile) ? await readFile(spec.logFile, 'utf8') : '',
      previous: existsSync(previous) ? (await stat(previous)).size : undefined,
      cwd,
    };
  }

  it('sets a log past the limit aside before starting', async () => {
    const run = await runLauncher('rotate', 'x'.repeat(LOG_MAX_BYTES + 1));
    expect(run.previous).toBe(LOG_MAX_BYTES + 1);
    expect(run.log).toBe(`started in ${run.cwd}\n`);
  }, 30_000);

  it('stops instead of restarting every 5 s when the connector is not paired', async () => {
    const run = await runLauncher('plain');
    expect(run.timedOut).toBe(false);
    expect(run.runs).toBe(1);
    expect(run.log).toContain(`started in ${run.cwd}`);
  }, 30_000);

  it('runs a folder whose name has %VARIABLES% in it as it is', async () => {
    const run = await runLauncher('a%OS%b & c');
    expect(run.runs).toBe(1);
    expect(run.log).toContain(`started in ${run.cwd}`);
  }, 30_000);

  it('runs a folder whose name is not ASCII', async () => {
    const run = await runLauncher('Jürgen தமிழ்');
    expect(run.runs).toBe(1);
  }, 30_000);
});

describe('what the service is given', () => {
  it('finds the pairing where setup saved it, whatever XDG_CONFIG_HOME told setup', () => {
    const setupEnv = { HOME: '/home/ana', XDG_CONFIG_HOME: '/data/ana-config', PATH: '/usr/bin' };
    const dir = configDir(setupEnv);
    const spec = serviceSpecFor({
      node: '/usr/bin/node',
      script: '/x/cord-connect.mjs',
      cwd: '/x',
      env: setupEnv,
      configDir: dir,
    });
    // The service's environment is only what the unit or plist lists, not setup's shell.
    expect(configDir(spec.env)).toBe(dir);
    expect(spec.configFile).toBe(join(dir, 'config.json'));
  });

  it('never writes the token into a unit, plist, launcher or crontab', () => {
    const spec = serviceSpecFor({
      node: '/usr/bin/node',
      script: '/x/cord-connect.mjs',
      cwd: '/x',
      env: { HOME: '/root', PATH: '/usr/bin', CORD_CONNECT_TOKEN: `cct_${'t'.repeat(43)}` },
      configDir: '/root/.config/cord-connect',
    });
    for (const text of [
      systemdUnit(spec, { system: true }),
      launchdPlist(spec),
      windowsLauncher(spec),
      cronLine(spec),
    ]) {
      expect(text).not.toMatch(/cct_|token/i);
    }
  });
});

describe('the log', () => {
  it('is set aside as <log>.1 past the limit, emptied in place, and left alone under it', async () => {
    const dir = await tempDir();
    const log = logPath(dir);
    await writeFile(log, '0123456789');
    await rotateLog(log, 20);
    expect(await readFile(log, 'utf8')).toBe('0123456789');
    await writeFile(log, 'x'.repeat(30));
    await rotateLog(log, 20);
    expect(await readFile(log, 'utf8')).toBe('');
    expect(await readFile(`${log}.1`, 'utf8')).toBe('x'.repeat(30));
    await rotateLog(join(dir, 'missing.log'), 20);
  });

  it.runIf(POSIX)('and its parts are readable by this user only', async () => {
    const dir = await tempDir();
    const log = logPath(dir);
    await writeFile(log, 'x'.repeat(30), { mode: 0o644 });
    await prepareLog(log, 20);
    expect((await stat(log)).mode & 0o777).toBe(0o600);
    expect((await stat(`${log}.1`)).mode & 0o777).toBe(0o600);
  });
});

describe.runIf(POSIX)('file modes', () => {
  it('keeps the pid and status files at 600 even when they were wider', async () => {
    const dir = await tempDir();
    await writeFile(pidPath(dir), '1\n', { mode: 0o644 });
    await writeFile(statusPath(dir), '{}', { mode: 0o644 });
    await writePid(dir);
    await writeStatus(dir, { connected: false, agents: [], at: new Date().toISOString(), pid: 1 });
    expect((await stat(pidPath(dir))).mode & 0o777).toBe(0o600);
    expect((await stat(statusPath(dir))).mode & 0o777).toBe(0o600);
  });

  it('creates the config folder at 700', async () => {
    const dir = join(await tempDir(), 'cord-connect');
    await writePid(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});

describe('the installed script and cleanup', () => {
  it('copies the downloaded bundle into the config folder, and runs source where it is', async () => {
    const dir = await tempDir();
    const downloads = await tempDir();
    const bundle = join(downloads, 'cord-connect.mjs');
    await writeFile(bundle, '// bundle\n');
    const installed = await installScript(bundle, dir);
    expect(installed).toBe(join(dir, 'cord-connect.mjs'));
    expect(await readFile(installed, 'utf8')).toBe('// bundle\n');
    // Running setup again from the installed copy keeps it.
    expect(await installScript(installed, dir)).toBe(installed);
    expect(await installScript(join(downloads, 'src', 'cli.ts'), dir)).toBe(
      join(downloads, 'src', 'cli.ts'),
    );
  });

  it('removes everything a run left but the pairing', async () => {
    const dir = await tempDir();
    for (const name of [
      'config.json',
      'cord-connect.pid',
      'status.json',
      'cord-connect.log',
      'cord-connect.log.1',
      'cord-connect.mjs',
      'cord-connect.vbs',
      'task.xml',
    ]) {
      await writeFile(join(dir, name), 'x');
    }
    await removeRunFiles(dir);
    expect(await readdir(dir)).toEqual(['config.json']);
  });
});

describe('recognising the connector behind a pid', () => {
  it('stops nothing for an old pid file that names no script', async () => {
    const dir = await tempDir();
    const { child } = sleeper();
    await writeFile(pidPath(dir), `${child.pid}\n`);
    const commandLineOf = () => `node ${join(dir, 'cord-connect.mjs')}`;
    expect(await stopRunning(dir, { commandLineOf })).toBe(false);
    expect(isAlive(child.pid!)).toBe(true);
  }, 30_000);

  it('stops nothing whose command line it cannot read', async () => {
    const dir = await tempDir();
    const { child } = sleeper();
    await writeFile(pidPath(dir), `${child.pid}\n/x/cord-connect.mjs\n`);
    expect(await stopRunning(dir, { commandLineOf: () => undefined })).toBe(false);
    expect(isAlive(child.pid!)).toBe(true);
  }, 30_000);
});
