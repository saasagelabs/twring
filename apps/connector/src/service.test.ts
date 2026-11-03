import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearPid,
  cronLine,
  CRON_MARKER,
  installService,
  launchdPlist,
  linuxServiceKind,
  pidPath,
  readStatus,
  shQuote,
  stopRunning,
  systemdQuote,
  systemdUnit,
  uninstallService,
  userUnitPath,
  waitConnected,
  windowsLauncher,
  windowsTaskXml,
  withCronLine,
  writePid,
  writeStatus,
  type ExecResult,
  type ServiceHost,
  type ServiceSpec,
} from './service';

const SPEC: ServiceSpec = {
  node: '/usr/local/bin/node',
  script: '/home/ana/my agents/cord-connect.mjs',
  cwd: '/home/ana/my agents',
  env: { PATH: '/usr/bin:/home/ana/.local/bin', HOME: '/home/ana', CORD_CONNECT_SERVICE: '1' },
  logFile: '/home/ana/.config/cord-connect/cord-connect.log',
};

const WIN_SPEC: ServiceSpec = {
  node: 'C:\\Program Files\\nodejs\\node.exe',
  script: 'C:\\Users\\Ana Lee\\cord-connect.mjs',
  cwd: 'C:\\Users\\Ana Lee',
  env: { PATH: 'C:\\Windows', HOME: 'C:\\Users\\Ana Lee', CORD_CONNECT_SERVICE: '1' },
  logFile: 'C:\\Users\\Ana Lee\\AppData\\Roaming\\cord-connect\\cord-connect.log',
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cord-service-'));
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
  const removed: string[] = [];
  let started = 0;
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
      removed.push(path);
      files.delete(path);
      return Promise.resolve();
    },
    startDetached: () => {
      started += 1;
    },
    ...overrides,
  };
  return { host, calls, files, removed, started: () => started };
}

describe('generated service text', () => {
  it('quotes systemd words with spaces, quotes, % and $', () => {
    expect(systemdQuote('/a b/c')).toBe('"/a b/c"');
    expect(systemdQuote('say "hi" \\ 100% $HOME')).toBe('"say \\"hi\\" \\\\ 100%% $$HOME"');
    expect(() => systemdQuote('a\nExecStart=/bin/evil')).toThrow();
  });

  it('writes a restarting systemd unit with PATH, HOME and the folder, and no token', () => {
    const unit = systemdUnit(SPEC, { system: false });
    expect(unit).toContain(
      'ExecStart="/usr/local/bin/node" "/home/ana/my agents/cord-connect.mjs"\n',
    );
    // systemd does not unquote WorkingDirectory=.
    expect(unit).toContain('WorkingDirectory=-/home/ana/my agents\n');
    expect(unit).toContain('Environment="PATH=/usr/bin:/home/ana/.local/bin"\n');
    expect(unit).toContain('Environment="HOME=/home/ana"\n');
    expect(unit).toContain('Restart=always\nRestartSec=5\n');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/cct_|--code|token/i);
    expect(systemdUnit(SPEC, { system: true })).toContain('WantedBy=multi-user.target');
  });

  it('writes a KeepAlive launchd plist with escaped paths', () => {
    const plist = launchdPlist({ ...SPEC, cwd: '/Users/ana/R&D <x>' });
    expect(plist).toContain('<string>ai.cord.connect</string>');
    expect(plist).toContain('<key>KeepAlive</key>\n    <true/>');
    expect(plist).toContain('<key>RunAtLoad</key>\n    <true/>');
    expect(plist).toContain('<string>/Users/ana/R&amp;D &lt;x&gt;</string>');
    expect(plist).toContain('<string>/home/ana/my agents/cord-connect.mjs</string>');
    expect(plist).toContain('<key>PATH</key>');
  });

  it('keeps the LaunchAgent alive only while the pairing exists', () => {
    const plist = launchdPlist({
      ...SPEC,
      configFile: '/Users/ana/.config/cord-connect/config.json',
    });
    expect(plist).toContain(
      '<key>KeepAlive</key>\n    <dict>\n      <key>PathState</key>\n      <dict>\n        <key>/Users/ana/.config/cord-connect/config.json</key>\n        <true/>',
    );
  });

  it('writes a hidden, looping Windows launcher that passes paths through the environment', () => {
    const vbs = windowsLauncher(WIN_SPEC);
    expect(vbs).toContain('env("CORD_CONNECT_NODE") = "C:\\Program Files\\nodejs\\node.exe"');
    expect(vbs).toContain('env("CORD_CONNECT_SCRIPT") = "C:\\Users\\Ana Lee\\cord-connect.mjs"');
    expect(vbs).toContain(
      'env("CORD_CONNECT_LOG") = "C:\\Users\\Ana Lee\\AppData\\Roaming\\cord-connect\\cord-connect.log"',
    );
    expect(vbs).toContain(
      'code = shell.Run("cmd.exe /d /v:off /s /c """"%CORD_PCT%CORD_CONNECT_NODE%CORD_PCT%"" ""%CORD_PCT%CORD_CONNECT_SCRIPT%CORD_PCT%"" >> ""%CORD_PCT%CORD_CONNECT_LOG%CORD_PCT%"" 2>&1""", 0, True)',
    );
    expect(vbs).toContain('shell.CurrentDirectory = "C:\\Users\\Ana Lee"');
    expect(vbs).toContain('env("CORD_CONNECT_SERVICE") = "1"');
    expect(vbs).toContain('If code = 78 Then Exit Do');
    expect(vbs).toContain('WScript.Sleep 5000');
    expect(vbs).not.toContain('env("PATH")');
  });

  it('writes a logon task that restarts on failure', () => {
    const xml = windowsTaskXml(WIN_SPEC, 'C:\\Users\\Ana Lee\\cord-connect.vbs', 'PC\\Ana');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>PC\\Ana</UserId>');
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain(
      '<Arguments>//B //Nologo &quot;C:\\Users\\Ana Lee\\cord-connect.vbs&quot;</Arguments>',
    );
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  it('quotes shell words and builds an @reboot line', () => {
    expect(shQuote("it's here")).toBe("'it'\\''s here'");
    const line = cronLine(SPEC);
    expect(line.startsWith("@reboot cd '/home/ana/my agents' && PATH=")).toBe(true);
    expect(line).toContain(
      "nohup '/usr/local/bin/node' '/home/ana/my agents/cord-connect.mjs' >> '/home/ana/.config/cord-connect/cord-connect.log' 2>&1 # cord-connect",
    );
  });

  it('replaces an earlier cord-connect crontab line instead of adding another', () => {
    const once = withCronLine('0 * * * * backup\n', cronLine(SPEC));
    const twice = withCronLine(once, cronLine(SPEC));
    expect(twice).toBe(once);
    expect(twice.split('\n').filter((l) => l.endsWith(CRON_MARKER))).toHaveLength(1);
    expect(withCronLine(twice, undefined)).toBe('0 * * * * backup\n');
    expect(withCronLine(`${cronLine(SPEC)}\n`, undefined)).toBe('');
  });
});

describe('installing', () => {
  it('picks a system unit for root with systemd, a user unit, else cron', () => {
    const root = fakeHost({ isRoot: true, exists: (p) => p === '/run/systemd/system' });
    expect(linuxServiceKind(root.host)).toBe('systemd-system');
    expect(linuxServiceKind(fakeHost().host)).toBe('systemd-user');
    const noUser = fakeHost({}, () => ({ status: 1, stdout: '', stderr: 'no bus' }));
    expect(linuxServiceKind(noUser.host)).toBe('cron');
  });

  it('installs a user unit, starts it, and says when lingering needs sudo', async () => {
    const fake = fakeHost({}, (call) =>
      call.command === 'loginctl'
        ? { status: 1, stdout: '', stderr: 'denied' }
        : { status: 0, stdout: '', stderr: '' },
    );
    const result = await installService(SPEC, fake.host, '/cfg');
    expect(result.kind).toBe('systemd-user');
    expect(fake.files.get(userUnitPath('/home/ana'))).toContain('Restart=always');
    expect(fake.calls.map((c) => c.args.join(' '))).toEqual([
      '--user show-environment',
      '--user daemon-reload',
      '--user enable cord-connect.service',
      '--user restart cord-connect.service',
      'enable-linger ana',
    ]);
    expect(result.notes).toEqual([
      'To keep Twring running when no one is logged in, run once: sudo loginctl enable-linger ana',
    ]);
  });

  it('falls back to crontab and starts the connector now', async () => {
    const fake = fakeHost({}, (call) => {
      if (call.command === 'systemctl') return { status: 1, stdout: '', stderr: '' };
      if (call.args[0] === '-l') {
        return { status: 0, stdout: `old ${CRON_MARKER}\n5 * * * * x\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const result = await installService(SPEC, fake.host, '/cfg');
    expect(result.kind).toBe('cron');
    const written = fake.calls.find((c) => c.command === 'crontab' && c.args[0] === '-');
    expect(written?.input).toBe(`5 * * * * x\n${cronLine(SPEC)}\n`);
    expect(fake.started()).toBe(1);
  });

  it('registers a Windows task from UTF-16 XML, removes the XML, and runs it', async () => {
    const fake = fakeHost({ platform: 'win32' });
    const result = await installService(WIN_SPEC, fake.host, 'C:\\cfg');
    expect(result.kind).toBe('windows-task');
    const create = fake.calls.find((c) => c.args[0] === '/Create');
    expect(create?.args).toEqual([
      '/Create',
      '/TN',
      'CORD connect',
      '/XML',
      join('C:\\cfg', 'task.xml'),
      '/F',
    ]);
    expect(fake.removed).toContain(join('C:\\cfg', 'task.xml'));
    expect(fake.calls.at(-1)?.args).toEqual(['/Run', '/TN', 'CORD connect']);
    // UTF-16 with a byte-order mark: Windows Script Host reads anything else as ANSI.
    const vbs = fake.files.get(join('C:\\cfg', 'cord-connect.vbs')) as Buffer;
    expect([...vbs.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(vbs.subarray(2).toString('utf16le')).toContain('WScript.Sleep');
  });

  it('loads a LaunchAgent with bootstrap, then the user domain (SSH), then load', async () => {
    const fake = fakeHost({ platform: 'darwin', home: '/Users/ana', uid: 501 }, (call) =>
      call.args[0] === 'bootstrap'
        ? { status: 5, stdout: '', stderr: 'io error' }
        : { status: 0, stdout: '', stderr: '' },
    );
    const result = await installService(SPEC, fake.host, '/cfg');
    expect(result.kind).toBe('launchd');
    const plist = join('/Users/ana', 'Library', 'LaunchAgents', 'ai.cord.connect.plist');
    expect(fake.calls.map((c) => c.args.join(' '))).toEqual([
      'bootout gui/501/ai.cord.connect',
      `bootstrap gui/501 ${plist}`,
      'bootout user/501/ai.cord.connect',
      `bootstrap user/501 ${plist}`,
      `unload ${plist}`,
      `load -w ${plist}`,
    ]);
  });

  it('uninstalls the user unit and the crontab line', async () => {
    const fake = fakeHost({}, (call) =>
      call.command === 'crontab' && call.args[0] === '-l'
        ? { status: 0, stdout: `a\n${cronLine(SPEC)}\n`, stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
    );
    fake.files.set(userUnitPath('/home/ana'), 'unit');
    await uninstallService(fake.host, '/cfg');
    expect(fake.removed).toContain(userUnitPath('/home/ana'));
    expect(fake.calls.find((c) => c.command === 'crontab' && c.args[0] === '-')?.input).toBe('a\n');
  });
});

/** A running process standing in for the service (waitConnected wants its pid alive). */
function sleeper(args: string[] = ['-e', 'setInterval(() => {}, 1000)']) {
  const child = spawn(process.execPath, args, { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  cleanups.push(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  return { child, exited };
}

describe('pid and status files', () => {
  it('reads back a status and waits for a fresh connected one', async () => {
    const dir = await tempDir();
    const { child } = sleeper();
    const since = Date.now();
    expect(await waitConnected(dir, since, { timeoutMs: 50, intervalMs: 10 })).toBeUndefined();
    await writeStatus(dir, {
      connected: true,
      agents: ['Hermes'],
      at: new Date(since - 60_000).toISOString(),
      pid: child.pid!,
    });
    // An old status from before setup started does not count.
    expect(await waitConnected(dir, since, { timeoutMs: 50, intervalMs: 10 })).toBeUndefined();
    setTimeout(
      () =>
        void writeStatus(dir, {
          connected: true,
          agents: ['Hermes'],
          at: new Date().toISOString(),
          pid: child.pid!,
        }),
      30,
    );
    const status = await waitConnected(dir, since, { timeoutMs: 2_000, intervalMs: 10 });
    expect(status?.agents).toEqual(['Hermes']);
  });

  it('ignores a damaged status file', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'status.json'), '{"connected":"yes"}');
    expect(await readStatus(dir)).toBeUndefined();
  });

  it('clears only its own pid file', async () => {
    const dir = await tempDir();
    await writePid(dir, '/opt/cord-connect.mjs');
    clearPid(dir, process.pid + 1);
    expect(await readFile(pidPath(dir), 'utf8')).toBe(
      `${process.pid}\n${resolve('/opt/cord-connect.mjs')}\n`,
    );
    clearPid(dir);
    await expect(readFile(pidPath(dir), 'utf8')).rejects.toThrow();
  });

  it('stops the connector named in the pid file, never itself', async () => {
    const dir = await tempDir();
    await writePid(dir);
    expect(await stopRunning(dir)).toBe(false);
    const script = join(dir, 'cord-connect.mjs');
    await writeFile(script, 'setInterval(() => {}, 1000);\n');
    const { child, exited } = sleeper([script]);
    await writeFile(pidPath(dir), `${child.pid}\n${script}\n`);
    expect(await stopRunning(dir)).toBe(true);
    await exited;
    await expect(readFile(pidPath(dir), 'utf8')).rejects.toThrow();
  }, 30_000);
});
