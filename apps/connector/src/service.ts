import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * `cord-connect setup` (ADR-027): runs the connector as a background service that starts at boot or
 * login and restarts when it stops. The unit, plist, and task text come from pure functions so they
 * can be tested without installing anything. No file written here ever holds the token: the service
 * runs the plain daemon, which reads the saved pairing itself.
 */

export const SYSTEMD_UNIT = 'cord-connect.service';
export const LAUNCHD_LABEL = 'ai.cord.connect';
export const WINDOWS_TASK = 'CORD connect';
export const CRON_MARKER = '# cord-connect';
/** Set in the service's environment: the daemon then never waits for a person (no prompts, no QR). */
export const SERVICE_ENV = 'CORD_CONNECT_SERVICE';
/**
 * The service's exit code when it has no usable pairing (sysexits' EX_CONFIG). Starting it again
 * cannot help, so no service manager does: systemd has `RestartPreventExitStatus=`, the Windows
 * launcher stops on it, and launchd keeps the job alive only while the pairing file exists.
 */
export const NOT_PAIRED_EXIT = 78;
/** Past this size the log starts again, the previous part kept as `<log>.1`. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** The script's stable copy in the config folder (the downloaded one may be in a temp folder). */
export const SCRIPT_FILE = 'cord-connect.mjs';

export interface ServiceSpec {
  /** Absolute path of the Node binary (`process.execPath`). */
  node: string;
  /** Absolute path of this script. */
  script: string;
  /** The folder setup ran in: the agents' working folder. */
  cwd: string;
  /** PATH (so the agents' binaries are found), HOME, the config folder, and the service marker. */
  env: Record<string, string>;
  /** Where the service's output goes when the system does not keep it (launchd, cron, Windows). */
  logFile: string;
  /** The saved pairing: launchd keeps the job alive only while it exists. */
  configFile?: string;
}

/** What the service runs: this Node and script, in this folder, with this PATH and config folder. */
export function serviceSpecFor({
  node,
  script,
  cwd,
  env,
  configDir,
}: {
  node: string;
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  configDir: string;
}): ServiceSpec {
  return {
    node,
    script,
    cwd,
    env: {
      PATH: env.PATH ?? env.Path ?? '',
      HOME: env.HOME ?? env.USERPROFILE ?? homedir(),
      [SERVICE_ENV]: '1',
      // Always: the service does not get XDG_CONFIG_HOME or APPDATA from setup's shell, so without
      // it the service could look for the pairing somewhere else.
      CORD_CONNECT_CONFIG_DIR: configDir,
    },
    logFile: logPath(configDir),
    configFile: join(configDir, 'config.json'),
  };
}

function noNewlines(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('A path or setting contains a line break.');
  return value;
}

/** systemd expands specifiers (`%h`, `%u`, ...) in every setting used here: `%` → `%%`. */
function systemdSpecifiers(value: string): string {
  return value.replace(/%/g, '%%');
}

/** A word in `ExecStart=`: double-quoted, with `\`, `"`, `%` (specifiers), and `$` (variables) escaped. */
export function systemdQuote(value: string): string {
  const escaped = noNewlines(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$$$');
  return `"${escaped}"`;
}

/**
 * An `Environment=` assignment: quoted like a word, but `$` is left alone. systemd.exec(5): the `$`
 * character has no special meaning there, so `$$` would reach the service as two dollars.
 */
export function systemdEnvQuote(value: string): string {
  const escaped = noNewlines(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${systemdSpecifiers(escaped)}"`;
}

/**
 * `WorkingDirectory=` takes the path as written (the unit prefixes it with `-`, so a folder removed
 * later does not stop the service at boot): systemd does not unquote it (a quoted path is not
 * absolute to it, and the unit fails to load). Only specifiers are escaped. systemd trims the value,
 * so a folder whose name starts or ends with a space cannot be named.
 */
export function systemdPath(value: string): string {
  noNewlines(value);
  if (!value.startsWith('/') || value !== value.trim()) {
    throw new Error(
      `systemd cannot use the folder "${value}" (its name starts or ends with a space). Run setup in another folder.`,
    );
  }
  return systemdSpecifiers(value);
}

export function systemdUnit(spec: ServiceSpec, { system }: { system: boolean }): string {
  const env = Object.entries(spec.env)
    .map(([key, value]) => `Environment=${systemdEnvQuote(`${key}=${value}`)}`)
    .join('\n');
  return `[Unit]
Description=Twring connect: lets the Twring app call the agents on this machine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(spec.node)} ${systemdQuote(spec.script)}
WorkingDirectory=-${systemdPath(spec.cwd)}
${env}
Restart=always
RestartSec=5
RestartPreventExitStatus=${NOT_PAIRED_EXIT}

[Install]
WantedBy=${system ? 'multi-user.target' : 'default.target'}
`;
}

export function xmlEscape(value: string): string {
  return noNewlines(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function launchdPlist(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(
      ([key, value]) =>
        `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`,
    )
    .join('\n');
  // Kept alive while the pairing exists: with none (never paired, or removed in the app) the
  // connector exits and launchd does not start it again every few seconds.
  const keepAlive =
    spec.configFile === undefined
      ? '<true/>'
      : `<dict>
      <key>PathState</key>
      <dict>
        <key>${xmlEscape(spec.configFile)}</key>
        <true/>
      </dict>
    </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(spec.node)}</string>
      <string>${xmlEscape(spec.script)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(spec.cwd)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    ${keepAlive}
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${xmlEscape(spec.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(spec.logFile)}</string>
  </dict>
</plist>
`;
}

/** A VBScript string literal: quotes doubled. */
function vbsString(value: string): string {
  return `"${noNewlines(value).replace(/"/g, '""')}"`;
}

/**
 * The Windows launcher the task runs: starts the connector with no window, its output appended to
 * the log, and starts it again 5 s after it stops (like systemd's `Restart=always`), unless it
 * stopped because it has no pairing. Before each start, a log past the size limit is set aside.
 *
 * `WScript.Shell.Run` expands `%NAME%` in its command, and cmd.exe expands it again, so no path is
 * written into the command: they go through the process environment, cmd.exe reads them once inside
 * quotes, and each `%` of the command itself is written as `%CORD_PCT%`, which Run turns into `%`.
 * Write the result as UTF-16 (`utf16WithBom`): Windows Script Host reads other files in the ANSI
 * code page, which breaks any path that is not ASCII.
 */
export function windowsLauncher(spec: ServiceSpec): string {
  const command =
    'cmd.exe /d /v:off /s /c ""%CORD_CONNECT_NODE%" "%CORD_CONNECT_SCRIPT%" >> "%CORD_CONNECT_LOG%" 2>&1"';
  const env: [string, string][] = [
    ['CORD_PCT', '%'],
    ['CORD_CONNECT_NODE', spec.node],
    ['CORD_CONNECT_SCRIPT', spec.script],
    ['CORD_CONNECT_LOG', spec.logFile],
    // The logged-in user's own PATH and HOME are right.
    ...Object.entries(spec.env).filter(([key]) => key !== 'PATH' && key !== 'HOME'),
  ];
  return [
    "' CORD connect: lets the Twring app call the agents on this computer.",
    'Set shell = CreateObject("WScript.Shell")',
    'Set env = shell.Environment("Process")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    ...env.map(([key, value]) => `env(${vbsString(key)}) = ${vbsString(value)}`),
    `shell.CurrentDirectory = ${vbsString(spec.cwd)}`,
    'logFile = env("CORD_CONNECT_LOG")',
    'Do',
    '  On Error Resume Next',
    '  If fso.FileExists(logFile) Then',
    `    If fso.GetFile(logFile).Size > ${LOG_MAX_BYTES} Then`,
    '      If fso.FileExists(logFile & ".1") Then fso.DeleteFile logFile & ".1", True',
    '      fso.MoveFile logFile, logFile & ".1"',
    '    End If',
    '  End If',
    '  On Error GoTo 0',
    `  code = shell.Run(${vbsString(command.replace(/%/g, '%CORD_PCT%'))}, 0, True)`,
    `  If code = ${NOT_PAIRED_EXIT} Then Exit Do`,
    '  WScript.Sleep 5000',
    'Loop',
    '',
  ].join('\r\n');
}

/** Text as UTF-16 LE with a byte-order mark: how Windows Script Host and schtasks read Unicode. */
export function utf16WithBom(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

/**
 * The scheduled task: at logon, as this user, no time limit, restarted if it fails. No working
 * folder here (Task Scheduler would expand `%NAME%` in it): the launcher sets it.
 */
export function windowsTaskXml(_spec: ServiceSpec, launcher: string, userId: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Lets the Twring app call the agents on this computer.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>//B //Nologo ${xmlEscape(`"${launcher}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** A POSIX shell word. */
export function shQuote(value: string): string {
  return `'${noNewlines(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The `@reboot` crontab line, used when systemd is not available. cron turns an unescaped `%` into
 * a line break (crontab(5)), so every `%` is written `\%`; a `\` right before a `%` cannot be
 * written at all.
 */
export function cronLine(spec: ServiceSpec): string {
  const values = [spec.cwd, spec.node, spec.script, spec.logFile, ...Object.values(spec.env)];
  if (values.some((value) => value.includes('\\%'))) {
    throw new Error('A path or PATH entry contains "\\%", which cron cannot run.');
  }
  const env = Object.entries(spec.env)
    .map(([key, value]) => `${key}=${shQuote(value)}`)
    .join(' ');
  const line = `@reboot cd ${shQuote(spec.cwd)} && ${env} nohup ${shQuote(spec.node)} ${shQuote(spec.script)} >> ${shQuote(spec.logFile)} 2>&1 ${CRON_MARKER}`;
  return line.replace(/%/g, '\\%');
}

/**
 * The crontab with any earlier cord-connect line replaced by `line` (or just removed). Every other
 * line, blank lines and comments included, stays as it was.
 */
export function withCronLine(crontab: string, line: string | undefined): string {
  const lines = crontab.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const kept = lines.filter((l) => !l.trimEnd().endsWith(CRON_MARKER));
  if (line !== undefined) kept.push(line);
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

// --- Installing ---------------------------------------------------------------------------------

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type Exec = (command: string, args: string[], input?: string) => ExecResult;

export interface ServiceHost {
  platform: NodeJS.Platform;
  isRoot: boolean;
  home: string;
  /** For launchd's `gui/<uid>` domain. */
  uid: number | undefined;
  /** The user name (`loginctl enable-linger`, the Windows task's user). */
  user: string;
  /** Windows: `DOMAIN\user`. */
  windowsUserId: string;
  exec: Exec;
  exists: (path: string) => boolean;
  writeFile: (path: string, data: string | Buffer, mode?: number) => Promise<void>;
  remove: (path: string) => Promise<void>;
  /** Starts the connector now, detached, when no service manager will. */
  startDetached: (spec: ServiceSpec) => void;
}

export type ServiceKind =
  'systemd-system' | 'systemd-user' | 'cron' | 'background' | 'launchd' | 'windows-task';

export interface InstallResult {
  kind: ServiceKind;
  /** Lines worth passing on, e.g. a step that needs an administrator. */
  notes: string[];
}

const ok = (r: ExecResult) => r.status === 0;

/** What a failed command said, as one line for the message the agent relays. */
function why(r: ExecResult): string {
  const said = `${r.stderr} ${r.stdout}`.replace(/\s+/g, ' ').trim();
  if (said !== '') return said;
  return r.status === null ? 'the command could not be run' : `exit code ${r.status}`;
}

/** The systems setup knows how to install a service on; anything else just starts it. */
function osOf(platform: NodeJS.Platform): 'linux' | 'darwin' | 'win32' | 'other' {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32' ? platform : 'other';
}

export function systemUnitPath(): string {
  return `/etc/systemd/system/${SYSTEMD_UNIT}`;
}
export function userUnitPath(home: string): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
}
export function plistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}
export function launcherPath(configDir: string): string {
  return join(configDir, 'cord-connect.vbs');
}

/** How setup will run the service on this machine (Linux depends on what is available). */
export function linuxServiceKind(host: ServiceHost): 'systemd-system' | 'systemd-user' | 'cron' {
  if (host.isRoot && host.exists('/run/systemd/system')) return 'systemd-system';
  if (!host.isRoot && ok(host.exec('systemctl', ['--user', 'show-environment']))) {
    return 'systemd-user';
  }
  return 'cron';
}

/**
 * Stops the installed service (if any) without removing it, so its manager does not start the
 * connector again while setup replaces it. Errors are ignored: nothing may be installed yet.
 */
export function stopService(host: ServiceHost): void {
  switch (osOf(host.platform)) {
    case 'linux':
      if (host.isRoot) host.exec('systemctl', ['stop', SYSTEMD_UNIT]);
      else host.exec('systemctl', ['--user', 'stop', SYSTEMD_UNIT]);
      return;
    case 'darwin':
      host.exec('launchctl', ['bootout', `gui/${host.uid ?? 0}/${LAUNCHD_LABEL}`]);
      host.exec('launchctl', ['bootout', `user/${host.uid ?? 0}/${LAUNCHD_LABEL}`]);
      return;
    case 'win32':
      host.exec('schtasks', ['/End', '/TN', WINDOWS_TASK]);
      return;
    case 'other':
      return;
  }
}

export async function installService(
  spec: ServiceSpec,
  host: ServiceHost,
  configDir: string,
): Promise<InstallResult> {
  switch (osOf(host.platform)) {
    case 'linux':
      return installLinux(spec, host);
    case 'darwin':
      return installMac(spec, host);
    case 'win32':
      return installWindows(spec, host, configDir);
    case 'other':
      host.startDetached(spec);
      return {
        kind: 'background',
        notes: ['It will not start again by itself after a restart on this system.'],
      };
  }
}

async function installLinux(spec: ServiceSpec, host: ServiceHost): Promise<InstallResult> {
  const kind = linuxServiceKind(host);
  if (kind === 'systemd-system') {
    await host.writeFile(systemUnitPath(), systemdUnit(spec, { system: true }), 0o644);
    host.exec('systemctl', ['daemon-reload']);
    host.exec('systemctl', ['enable', SYSTEMD_UNIT]);
    const started = host.exec('systemctl', ['restart', SYSTEMD_UNIT]);
    if (!ok(started)) throw new Error(`Could not start the service: ${why(started)}`);
    return { kind, notes: [] };
  }
  if (kind === 'systemd-user') {
    await host.writeFile(userUnitPath(host.home), systemdUnit(spec, { system: false }), 0o644);
    host.exec('systemctl', ['--user', 'daemon-reload']);
    host.exec('systemctl', ['--user', 'enable', SYSTEMD_UNIT]);
    const started = host.exec('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
    if (!ok(started)) throw new Error(`Could not start the service: ${why(started)}`);
    // Without lingering, a user service stops when the user logs out (and waits for a login).
    const notes = ok(host.exec('loginctl', ['enable-linger', host.user]))
      ? []
      : [
          `To keep Twring running when no one is logged in, run once: sudo loginctl enable-linger ${host.user}`,
        ];
    return { kind, notes };
  }
  const line = cronLine(spec);
  const current = host.exec('crontab', ['-l']);
  // `crontab -l` fails when there is no crontab yet. Any other failure: leave the crontab alone,
  // since writing ours would replace every line of the user's.
  const none =
    !ok(current) &&
    current.status !== null &&
    /no crontab|no such file/i.test(`${current.stderr} ${current.stdout}`);
  const installed =
    (ok(current) || none) &&
    ok(host.exec('crontab', ['-'], withCronLine(ok(current) ? current.stdout : '', line)));
  host.startDetached(spec);
  return installed
    ? { kind: 'cron', notes: [] }
    : {
        kind: 'background',
        notes: ['It will not start again by itself after a restart (cron is not available).'],
      };
}

async function installMac(spec: ServiceSpec, host: ServiceHost): Promise<InstallResult> {
  const path = plistPath(host.home);
  await host.writeFile(path, launchdPlist(spec), 0o644);
  const domain = `gui/${host.uid ?? 0}`;
  host.exec('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
  if (ok(host.exec('launchctl', ['bootstrap', domain, path])))
    return { kind: 'launchd', notes: [] };
  // No GUI session (signed in over SSH): the user's background domain still runs it.
  const background = `user/${host.uid ?? 0}`;
  host.exec('launchctl', ['bootout', `${background}/${LAUNCHD_LABEL}`]);
  if (!ok(host.exec('launchctl', ['bootstrap', background, path]))) {
    host.exec('launchctl', ['unload', path]);
    const loaded = host.exec('launchctl', ['load', '-w', path]);
    if (!ok(loaded)) throw new Error(`Could not start the service: ${why(loaded)}`);
  }
  return { kind: 'launchd', notes: [] };
}

async function installWindows(
  spec: ServiceSpec,
  host: ServiceHost,
  configDir: string,
): Promise<InstallResult> {
  const launcher = launcherPath(configDir);
  await host.writeFile(launcher, utf16WithBom(windowsLauncher(spec)));
  // schtasks reads task XML as UTF-16 with a byte-order mark.
  const xmlPath = join(configDir, 'task.xml');
  const xml = windowsTaskXml(spec, launcher, host.windowsUserId);
  await host.writeFile(xmlPath, utf16WithBom(xml));
  try {
    const created = host.exec('schtasks', ['/Create', '/TN', WINDOWS_TASK, '/XML', xmlPath, '/F']);
    if (!ok(created)) throw new Error(`Could not add the startup task: ${why(created)}`);
  } finally {
    await host.remove(xmlPath);
  }
  const started = host.exec('schtasks', ['/Run', '/TN', WINDOWS_TASK]);
  if (!ok(started)) throw new Error(`Could not start the task: ${why(started)}`);
  return { kind: 'windows-task', notes: [] };
}

/** Removes every kind of service setup may have installed here. Missing pieces are fine. */
export async function uninstallService(host: ServiceHost, configDir: string): Promise<void> {
  switch (osOf(host.platform)) {
    case 'linux': {
      if (host.isRoot && host.exists(systemUnitPath())) {
        host.exec('systemctl', ['disable', '--now', SYSTEMD_UNIT]);
        await host.remove(systemUnitPath());
        host.exec('systemctl', ['daemon-reload']);
      }
      if (host.exists(userUnitPath(host.home))) {
        host.exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
        await host.remove(userUnitPath(host.home));
        host.exec('systemctl', ['--user', 'daemon-reload']);
      }
      const current = host.exec('crontab', ['-l']);
      if (ok(current) && current.stdout.includes(CRON_MARKER)) {
        host.exec('crontab', ['-'], withCronLine(current.stdout, undefined));
      }
      return;
    }
    case 'darwin': {
      const path = plistPath(host.home);
      const gui = ok(host.exec('launchctl', ['bootout', `gui/${host.uid ?? 0}/${LAUNCHD_LABEL}`]));
      const user = ok(
        host.exec('launchctl', ['bootout', `user/${host.uid ?? 0}/${LAUNCHD_LABEL}`]),
      );
      if (!gui && !user) host.exec('launchctl', ['unload', path]);
      await host.remove(path);
      return;
    }
    case 'win32':
      host.exec('schtasks', ['/End', '/TN', WINDOWS_TASK]);
      host.exec('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F']);
      await host.remove(launcherPath(configDir));
      return;
    case 'other':
      return;
  }
}

// --- The running connector's files ---------------------------------------------------------------

export interface RunStatus {
  connected: boolean;
  agents: string[];
  at: string;
  pid: number;
}

export function pidPath(configDir: string): string {
  return join(configDir, 'cord-connect.pid');
}
export function statusPath(configDir: string): string {
  return join(configDir, 'status.json');
}
export function logPath(configDir: string): string {
  return join(configDir, 'cord-connect.log');
}

/** The folder (mode 700 when created) and a file in it, readable by this user only (600). */
async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
  // `mode` applies only when the file is created.
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

/** The pid file: this process's pid and script, so a later setup can tell it is still this. */
export async function writePid(
  configDir: string,
  script: string = process.argv[1] ?? '',
): Promise<void> {
  // No script, nothing to recognise it by: `resolve('')` would be the current folder.
  const recorded = script === '' ? '' : resolve(script);
  await writePrivate(pidPath(configDir), `${process.pid}\n${recorded}\n`);
}

/** Removes the pid file if it is still this process's. Synchronous: it runs on `exit`. */
export function clearPid(configDir: string, pid = process.pid): void {
  try {
    if (Number.parseInt(readFileSync(pidPath(configDir), 'utf8'), 10) === pid) {
      rmSync(pidPath(configDir), { force: true });
    }
  } catch {
    // No pid file: nothing to clear.
  }
}

export async function writeStatus(configDir: string, status: RunStatus): Promise<void> {
  await writePrivate(statusPath(configDir), `${JSON.stringify(status)}\n`);
}

export async function readStatus(configDir: string): Promise<RunStatus | undefined> {
  try {
    const parsed = JSON.parse(await readFile(statusPath(configDir), 'utf8')) as Partial<RunStatus>;
    if (
      typeof parsed.connected !== 'boolean' ||
      typeof parsed.at !== 'string' ||
      typeof parsed.pid !== 'number' ||
      !Array.isArray(parsed.agents)
    ) {
      return undefined;
    }
    return {
      connected: parsed.connected,
      at: parsed.at,
      pid: parsed.pid,
      agents: parsed.agents.filter((a): a is string => typeof a === 'string'),
    };
  } catch {
    return undefined;
  }
}

/** Forgets the last run's status, so setup only ever reads one the new service wrote. */
export async function clearStatus(configDir: string): Promise<void> {
  await rm(statusPath(configDir), { force: true });
}

/**
 * Keeps the log under `max` bytes: past it, the log is copied to `<log>.1` (replacing the older
 * part) and emptied in place, so a writer that opened it for appending (launchd, a shell's `>>`)
 * keeps writing at its new start. Both stay readable by this user only.
 */
export async function rotateLog(path: string, max = LOG_MAX_BYTES): Promise<void> {
  const size = await stat(path).then(
    (s) => s.size,
    () => undefined,
  );
  if (size === undefined || size <= max) return;
  await copyFile(path, `${path}.1`);
  await truncate(path, 0);
  if (process.platform !== 'win32') await chmod(`${path}.1`, 0o600);
}

/** Waits before each new try of a file another process still holds. */
const BUSY_RETRY_MS: readonly number[] = [100, 300, 600, 1000];

/**
 * Windows: a service that was just stopped can hold its files for a moment longer (EBUSY), and a
 * held file can also refuse removal (EPERM). Elsewhere EPERM is a real permission problem.
 */
function isBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBUSY' || (code === 'EPERM' && process.platform === 'win32');
}

/** Runs `op`, trying again after each wait while the file is busy; other errors throw at once. */
export async function retryWhileBusy<T>(
  op: () => Promise<T>,
  waits: readonly number[] = BUSY_RETRY_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      const wait = waits[attempt];
      if (!isBusy(error) || wait === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * Before the service starts: the log exists with mode 600 (launchd and cron append to an existing
 * file and keep its mode) and is under the size limit.
 */
export async function prepareLog(
  path: string,
  max = LOG_MAX_BYTES,
  deps: {
    rotate?: (path: string, max: number) => Promise<void>;
    waits?: readonly number[];
  } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // A log still held by the service just stopped is rotated on a later start instead.
  try {
    await retryWhileBusy(() => (deps.rotate ?? rotateLog)(path, max), deps.waits);
  } catch (error) {
    if (!isBusy(error)) throw error;
  }
  // Opening it waits for that service too; a log that never frees fails setup with a clear error.
  await retryWhileBusy(() => writeFile(path, '', { flag: 'a', mode: 0o600 }), deps.waits);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

/**
 * The script the service runs: the downloaded bundle is copied into the config folder, so the
 * service keeps working when the folder it was downloaded to (often a temp folder) is cleaned.
 * Running from source (`cli.ts`), it stays where it is.
 */
export async function installScript(script: string, configDir: string): Promise<string> {
  const source = resolve(script);
  const target = join(configDir, SCRIPT_FILE);
  if (!source.endsWith('.mjs') || source === resolve(target)) return source;
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await copyFile(source, target);
  if (process.platform !== 'win32') await chmod(target, 0o600);
  return target;
}

/**
 * Everything a run left in the config folder except the pairing itself. A file still held by the
 * service just stopped (Windows) is left behind rather than failing the uninstall; resolves those.
 */
export async function removeRunFiles(
  configDir: string,
  deps: { remove?: (path: string) => Promise<void>; waits?: readonly number[] } = {},
): Promise<string[]> {
  const left: string[] = [];
  const remove = deps.remove ?? ((path: string) => rm(path, { force: true }));
  const log = logPath(configDir);
  for (const path of [
    pidPath(configDir),
    statusPath(configDir),
    log,
    `${log}.1`,
    join(configDir, SCRIPT_FILE),
    launcherPath(configDir),
    join(configDir, 'task.xml'),
  ]) {
    try {
      await retryWhileBusy(() => remove(path), deps.waits);
    } catch (error) {
      if (!isBusy(error)) throw error;
      left.push(path);
    }
  }
  return left;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A process's command line, or undefined when it cannot be read. */
export type CommandLineOf = (pid: number) => string | undefined;

export const systemCommandLine: CommandLineOf = (pid) => {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    }
    const result =
      process.platform === 'win32'
        ? spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
            ],
            { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
          )
        : spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 5_000,
          });
    const line = result.status === 0 ? result.stdout.trim() : '';
    return line === '' ? undefined : line;
  } catch {
    return undefined;
  }
};

/** Whether a command line is still the connector that wrote the pid file (its script's path). */
export function runsScript(commandLine: string | undefined, script: string): boolean {
  if (commandLine === undefined || script === '') return false;
  return process.platform === 'win32'
    ? commandLine.toLowerCase().includes(script.toLowerCase())
    : commandLine.includes(script);
}

async function readPidFile(
  configDir: string,
): Promise<{ pid: number; script: string } | undefined> {
  const text = await readFile(pidPath(configDir), 'utf8').catch(() => '');
  const [first = '', script = ''] = text.split('\n');
  const pid = Number.parseInt(first, 10);
  return Number.isInteger(pid) && pid > 0 ? { pid, script: script.trim() } : undefined;
}

/**
 * Stops a connector already running with this config (its pid file), waiting up to `timeoutMs`
 * for it to go. Returns whether one was stopped. After a crash or a restart the pid may belong to
 * another program, so it is stopped only while its command line still runs the recorded script;
 * a copy it cannot recognise is left alone (the server lets only the newest copy stay connected).
 */
export async function stopRunning(
  configDir: string,
  {
    timeoutMs = 5_000,
    self = process.pid,
    commandLineOf = systemCommandLine,
  }: { timeoutMs?: number; self?: number; commandLineOf?: CommandLineOf } = {},
): Promise<boolean> {
  const recorded = await readPidFile(configDir);
  await rm(pidPath(configDir), { force: true });
  if (recorded === undefined) return false;
  const { pid, script } = recorded;
  if (pid === self || !alive(pid) || !runsScript(commandLineOf(pid), script)) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone in the meantime.
    }
  }
  return true;
}

/**
 * Waits for the service to report connected: a status written after `since` by a process that is
 * still running and is the one in the pid file (when there is one), not a copy that has crashed or
 * an older one still around.
 */
export async function waitConnected(
  configDir: string,
  since: number,
  { timeoutMs = 20_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<RunStatus | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await readStatus(configDir);
    if (
      status?.connected === true &&
      Date.parse(status.at) >= since &&
      status.pid !== process.pid &&
      alive(status.pid)
    ) {
      const running = await readPidFile(configDir);
      if (running === undefined || running.pid === status.pid) return status;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// --- The real machine ---------------------------------------------------------------------------

export function systemHost(): ServiceHost {
  const env = process.env;
  const user = env.USER ?? env.LOGNAME ?? env.USERNAME ?? '';
  return {
    platform: process.platform,
    isRoot: process.getuid?.() === 0,
    home: env.HOME ?? env.USERPROFILE ?? '',
    uid: process.getuid?.(),
    user,
    windowsUserId: env.USERDOMAIN !== undefined ? `${env.USERDOMAIN}\\${user}` : user,
    exec: (command, args, input) => {
      const result = spawnSync(command, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        ...(input !== undefined && { input }),
      });
      return {
        status: result.error !== undefined ? null : result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? result.error?.message ?? '',
      };
    },
    exists: (path) => existsSync(path),
    writeFile: async (path, data, mode) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, mode !== undefined ? { mode } : {});
    },
    remove: (path) => rm(path, { force: true }),
    startDetached: (spec) => {
      const log = openSync(spec.logFile, 'a', 0o600);
      spawn(spec.node, [spec.script], {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        detached: true,
        stdio: ['ignore', log, log],
        windowsHide: true,
      }).unref();
    },
  };
}
