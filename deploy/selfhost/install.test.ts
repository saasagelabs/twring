import { spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The installer and the `twring` command run under a real POSIX sh with a fake PATH: stub docker,
// curl, node, systemctl, id, uname, ip, sleep and a recording chmod (test-stubs/), plus the
// system's coreutils and openssl. Nothing reaches Docker or the network.

const WIN = process.platform === 'win32';
const SH = process.env.TWRING_TEST_SH ?? (WIN ? 'C:/Program Files/Git/usr/bin/sh.exe' : '/bin/sh');
const SYSTEM_PATH = WIN ? ['C:/Program Files/Git/usr/bin'] : ['/usr/bin', '/bin'];
const PATH_SEP = WIN ? ';' : ':';
const HERE = fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/');
const INSTALL = `${HERE}install.sh`;
const TWRING = `${HERE}twring`;
const STUBS = `${HERE}test-stubs`;

const OLD = `sha256:${'a'.repeat(64)}`;
const NEW = `sha256:${'b'.repeat(64)}`;
const REPO = 'ghcr.io/saasagelabs/twring';
const CONNECT = 'console.log("connector")';
const connectDigest = `sha256:${createHash('sha256').update(CONNECT).digest('hex')}`;
const KIT_FILES = [
  'compose.own.yml',
  'compose.twring.yml',
  'Caddyfile.tmpl',
  'livekit.yaml.tmpl',
  'twring',
];
let kitDigest = `sha256:${'0'.repeat(64)}`;
let kitPath = '';
const versions = (latest: string, extra: Record<string, string> = {}) =>
  JSON.stringify({
    images: { latest, '1': latest },
    kit: kitDigest,
    connect: connectDigest,
    ...extra,
  });
const SPEECH_KEY = 'dg_secret_key_123';

/** A path as Git's sh on Windows writes it in /etc/passwd style files (no drive colon). */
const posix = (path: string) => (WIN ? `/${path[0]!.toLowerCase()}${path.slice(2)}` : path);

const onPath = (name: string) => SYSTEM_PATH.some((dir) => existsSync(join(dir, name)));
const canRun = existsSync(SH) && (onPath('openssl') || onPath('openssl.exe'));

interface Call {
  cmd: string;
  cwd?: string;
  args: string[];
  env: string[];
}

/** The published kit (templates and `twring`), as install.sh downloads it under `curl | sh`. */
function makeKit() {
  const dir = mkdtempSync(join(tmpdir(), 'twring-kit-')).replaceAll(String.fromCharCode(92), '/');
  for (const name of KIT_FILES) copyFileSync(join(HERE, name), join(dir, name));
  spawnSync(SH, ['-c', `tar -czf kit.tar.gz ${KIT_FILES.join(' ')}`], {
    cwd: dir,
    env: { PATH: SYSTEM_PATH.join(PATH_SEP) },
  });
  kitPath = `${dir}/kit.tar.gz`;
  kitDigest = `sha256:${createHash('sha256').update(readFileSync(kitPath)).digest('hex')}`;
}
if (existsSync(SH)) makeKit();

function box(options: { without?: string[]; extra?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'twring-install-')).replaceAll('\\', '/');
  const bin = `${dir}/bin`;
  mkdirSync(bin);
  for (const name of readdirSync(STUBS)) {
    if (options.without?.includes(name)) continue;
    copyFileSync(join(STUBS, name), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  for (const [name, body] of Object.entries(options.extra ?? {})) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  for (const person of ['alice', 'bob', 'carol', 'erin']) {
    mkdirSync(`${dir}/home/${person}`, { recursive: true });
  }
  const root = `${dir}/opt/twring`;
  const binDir = `${dir}/usr/local/bin`;
  writeFileSync(`${dir}/calls.log`, '');

  const run = (script: string, args: string[], env: Record<string, string> = {}, stdin = '') => {
    const result = spawnSync(
      SH,
      [script, ...args].filter((a) => a !== ''),
      {
        env: {
          PATH: [bin, ...SYSTEM_PATH].join(PATH_SEP),
          HOME: dir,
          TMPDIR: dir,
          STUB_DIR: dir,
          TWRING_ROOT: root,
          TWRING_BIN_DIR: binDir,
          STUB_VERSIONS: versions(OLD),
          STUB_CONNECT: CONNECT,
          STUB_KIT: kitPath,
          STUB_HOME_BASE: posix(`${dir}/home`),
          // Never the machine's own /run/user (a logged-in uid 1000 there changes the link line).
          TWRING_RUN_USER_DIR: `${dir}/run/user`,
          ...env,
        },
        cwd: dir,
        input: stdin,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  };

  const calls = (): Call[] =>
    readFileSync(`${dir}/calls.log`, 'utf8')
      .split('@@ ')
      .filter((chunk) => chunk !== '')
      .map((chunk) => {
        const [cmd, ...lines] = chunk.replace(/\n$/, '').split('\n');
        return {
          cmd: cmd!,
          args: lines.filter((l) => !l.startsWith('ENV ') && !l.startsWith('CWD ')),
          cwd: lines.find((l) => l.startsWith('CWD '))?.slice(4),
          env: lines.filter((l) => l.startsWith('ENV ')),
        };
      });
  const docker = () => calls().filter((c) => c.cmd === 'docker');
  /** `cat install.sh | sh -s -- <args>`: the script arrives on stdin, as with curl. */
  const piped = (text: string, args: string[], env: Record<string, string> = {}) =>
    // `exec sh` found on PATH, so $0 is plain "sh" (dirname ".": the working directory).
    run('-c', ['exec sh -s -- "$@"', 'sh', ...args], env, text);
  const home = posix(`${dir}/home`);
  return { dir, home, root, binDir, run, piped, calls, docker };
}

const BASE_ENV = {
  TWRING_SPEECH_KEY: SPEECH_KEY,
  TWRING_SPEECH_PROVIDER: 'deepgram',
  TWRING_EMAIL: 'owner@example.com',
  TWRING_NEWS: 'no',
  STUB_FIRST_ADMIN: 'per_admin',
  SUDO_USER: 'alice',
};

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const mode = (file: string) => statSync(file).mode & 0o777;
const chmodded = (b: ReturnType<typeof box>, m: string, file: string) =>
  b.calls().some((c) => c.cmd === 'chmod' && c.args[0] === m && c.args[1] === file);

describe.skipIf(!canRun)('install.sh', { timeout: 60_000 }, () => {
  it('stops with the Docker link when Docker is missing', () => {
    if (onPath('docker')) return; // A real docker on the system path would shadow the test.
    const b = box({ without: ['docker'] });
    const { status, out } = b.run(INSTALL, ['--yes'], BASE_ENV);
    expect(status).toBe(1);
    expect(out).toContain('https://docs.docker.com/engine/install/');
  });

  it('with --yes and no TWRING_EMAIL, stops naming the setting and writes nothing', () => {
    const b = box();
    const env = Object.fromEntries(
      Object.entries(BASE_ENV).filter(([name]) => name !== 'TWRING_EMAIL'),
    );
    const { status, out } = b.run(INSTALL, ['--yes'], env);
    expect(status).toBe(1);
    expect(out).toContain('TWRING_EMAIL');
    expect(existsSync(`${b.root}/twring.env`)).toBe(false);
  });

  it('never touches an existing install and suggests twring update', () => {
    const b = box();
    mkdirSync(b.root, { recursive: true });
    writeFileSync(`${b.root}/twring.env`, 'TWRING_ADMIN_TOKEN=keep-me\n');
    writeFileSync(`${b.root}/compose.yml`, 'services: {}\n');
    const before = [sha(`${b.root}/twring.env`), sha(`${b.root}/compose.yml`)];
    const { status, out } = b.run(INSTALL, ['--yes'], BASE_ENV);
    expect(status).toBe(0);
    expect(out).toContain('twring update');
    expect([sha(`${b.root}/twring.env`), sha(`${b.root}/compose.yml`)]).toEqual(before);
    expect(b.docker()).toHaveLength(0);
  });

  it('stops when the pulled image does not match the published digest', () => {
    const b = box();
    const { status, out } = b.run(INSTALL, ['--yes'], { ...BASE_ENV, STUB_DIGEST_MISMATCH: '1' });
    expect(status).toBe(1);
    expect(out).toMatch(/does not match the published digest/);
    expect(existsSync(`${b.root}/twring.env`)).toBe(false);
  });

  it('stops when the speech provider refuses the key', () => {
    const b = box();
    const { status, out } = b.run(INSTALL, ['--yes'], { ...BASE_ENV, STUB_SPEECH_EXIT: '2' });
    expect(status).toBe(1);
    expect(out).toMatch(/refused that key/);
    expect(existsSync(`${b.root}/twring.env`)).toBe(false);
  });

  describe('a full install with every port open', () => {
    const b = box();
    const result = b.run(INSTALL, ['--yes'], BASE_ENV);

    it('finishes, prints the address and the admin code', () => {
      expect(result.out).toContain('Twring is running at https://203-0-113-7.sslip.io');
      expect(result.out).toContain('K7QM-2XPA');
      expect(result.out).toContain(
        'twring://pair?server=https%3A%2F%2F203-0-113-7.sslip.io&code=K7QM-2XPA&id=srv_abc',
      );
      expect(result.status).toBe(0);
    });

    it('pins the image by digest and chooses own audio', () => {
      const compose = parse(readFileSync(`${b.root}/compose.yml`, 'utf8')) as {
        services: Record<string, { image?: string; environment?: Record<string, string> }>;
      };
      expect(compose.services.twring!.image).toBe(`${REPO}@${OLD}`);
      expect(compose.services.twring!.environment!.TWRING_AUDIO).toBe('own');
      expect(Object.keys(compose.services).sort()).toEqual(['caddy', 'livekit', 'twring']);
      expect(readFileSync(`${b.root}/Caddyfile`, 'utf8')).toContain('livekit.203-0-113-7.sslip.io');
    });

    it('passes the speech key only through the environment', () => {
      const check = b.docker().find((c) => c.args.includes('dist/check-speech-key.js'))!;
      expect(check.args).toEqual(expect.arrayContaining(['-e', 'TWRING_SPEECH_KEY']));
      expect(check.env).toContain(`ENV TWRING_SPEECH_KEY=${SPEECH_KEY}`);
      for (const call of b.calls()) {
        expect(call.args.join(' ')).not.toContain(SPEECH_KEY);
      }
      expect(result.out).not.toContain(SPEECH_KEY);
    });

    it('creates the server key inside the data volume as uid 10001, from stdin', () => {
      const keyRun = b
        .docker()
        .find((c) => c.args[0] === 'run' && c.args.some((a) => a.includes('server-key.pem')))!;
      expect(keyRun.args).toEqual(
        expect.arrayContaining(['-i', '--user', '10001:10001', '-v', 'twring_twring-data:/data']),
      );
      expect(readFileSync(`${b.dir}/volume-stdin`, 'utf8')).toContain('BEGIN PRIVATE KEY');
      expect(
        b.docker().some((c) => c.args[0] === 'volume' && c.args.includes('twring_twring-data')),
      ).toBe(true);
    });

    it('registers with the relay at the sslip.io address', () => {
      const register = b.docker().find((c) => c.args.includes('register'))!;
      expect(register.args).toEqual(
        expect.arrayContaining([
          '--email',
          'owner@example.com',
          '--address',
          '203-0-113-7.sslip.io',
          '--user',
          '10001:10001',
        ]),
      );
    });

    it('writes twring.env 600 with the secrets and livekit.yaml 644', () => {
      const env = readFileSync(`${b.root}/twring.env`, 'utf8');
      expect(env).toContain(`DEEPGRAM_API_KEY=${SPEECH_KEY}`);
      expect(env).toMatch(/^TWRING_ADMIN_TOKEN=[0-9a-f]{64}$/m);
      expect(env).toMatch(/^CORD_CREDENTIALS_KEY=\S{44}$/m);
      expect(env).toMatch(/^LIVEKIT_API_KEY=API[0-9a-f]{16}$/m);
      expect(env).toContain('TWRING_SERVER_KEY_FILE=/data/keys/server-key.pem');
      expect(env).toContain('TWRING_RELAY_KEY_FILE=/data/keys/relay-key');
      expect(chmodded(b, '600', `${b.root}/twring.env.new`)).toBe(true);
      expect(chmodded(b, '644', `${b.root}/livekit.yaml`)).toBe(true);
      if (!WIN) {
        expect(mode(`${b.root}/twring.env`)).toBe(0o600);
        expect(mode(`${b.root}/livekit.yaml`)).toBe(0o644);
      }
    });

    it('gives every compose call the env file, compose file and project', () => {
      const compose = b.docker().filter((c) => c.args[0] === 'compose');
      expect(compose.length).toBeGreaterThan(2);
      for (const call of compose) {
        if (call.args[1] === 'version') continue;
        expect(call.args.slice(0, 7)).toEqual([
          'compose',
          '--env-file',
          `${b.root}/twring.env`,
          '-f',
          `${b.root}/compose.yml`,
          '-p',
          'twring',
        ]);
      }
    });

    it('installs the twring command and links agents after the admin pairs', () => {
      expect(existsSync(`${b.binDir}/twring`)).toBe(true);
      const link = b.calls().find((c) => c.cmd === 'runuser')!;
      expect(link.args.slice(0, 3)).toEqual(['-l', 'alice', '-c']);
      expect(link.args[3]).toBe(
        `cd '${b.home}/alice' && exec node '${b.root}/twring-connect.mjs' setup --code 'ABCD-EFGH' --server 'https://203-0-113-7.sslip.io'`,
      );
      const order = b.docker().map((c) => c.args.join(' '));
      const firstAdmin = order.findIndex((a) => a.includes('first-admin'));
      expect(firstAdmin).toBeGreaterThan(order.findIndex((a) => a.includes(' code --admin --qr')));
      expect(order.findIndex((a) => a.includes('connector-code per_admin'))).toBeGreaterThan(
        firstAdmin,
      );
    });
  });

  it('shares agents with people added only when asked (TWRING_SHARE_AGENTS=yes)', () => {
    const b = box();
    const { status } = b.run(INSTALL, ['--yes'], { ...BASE_ENV, TWRING_SHARE_AGENTS: 'yes' });
    expect(status).toBe(0);
    const link = b.calls().find((c) => c.cmd === 'runuser')!;
    expect(link.args[3]).toMatch(/ --shared$/);
  });

  it('waits for the probe echo to say it is listening before asking for the probe', () => {
    const b = box();
    b.run(INSTALL, ['--yes'], FAST);
    const order = b.docker().map((c) => c.args.join(' '));
    const echo = order.findIndex((a) => a.includes('dist/probe-echo.js'));
    const logs = order.findIndex((a) => a.startsWith('logs') && a.includes('twring-probe-echo'));
    const probe = order.findIndex((a) => a.includes('probe --address'));
    expect(echo).toBeGreaterThanOrEqual(0);
    expect(logs).toBeGreaterThan(echo);
    expect(probe).toBeGreaterThan(logs);
  });

  it('records media over TCP only in install.conf when 7882/udp is closed', () => {
    const b = box();
    b.run(INSTALL, ['--yes'], {
      ...FAST,
      STUB_PROBE: '{"tcp7881":{"ok":true},"udp7882":{"ok":false}}',
    });
    expect(readFileSync(`${b.root}/install.conf`, 'utf8')).toContain("TWRING_MEDIA='tcp'");
    const all = box();
    all.run(INSTALL, ['--yes'], FAST);
    expect(readFileSync(`${all.root}/install.conf`, 'utf8')).not.toContain('TWRING_MEDIA=');
  });

  it('audio auto chooses Twring audio when 7881 and 7882 are closed, and prints firewall lines', () => {
    const b = box();
    const { status, out } = b.run(INSTALL, ['--yes'], {
      ...BASE_ENV,
      TWRING_LINK_AGENTS: 'no',
      STUB_PROBE: '{"tcp7881":{"ok":false},"udp7882":{"ok":false}}',
    });
    expect(status).toBe(0);
    expect(out).toContain('ufw allow 7882/udp');
    expect(out).toContain('ufw allow 7881/tcp');
    expect(out).toMatch(/cloud provider/);
    expect(out).toContain('twring link');
    const compose = parse(readFileSync(`${b.root}/compose.yml`, 'utf8')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    expect(Object.keys(compose.services).sort()).toEqual(['caddy', 'twring']);
    expect(compose.services.twring!.environment!.TWRING_AUDIO).toBe('twring');
    expect(readFileSync(`${b.root}/Caddyfile`, 'utf8')).not.toContain('livekit');
    expect(readFileSync(`${b.root}/twring.env`, 'utf8')).not.toContain('LIVEKIT');
    expect(b.calls().some((c) => c.cmd === 'runuser')).toBe(false);
  });

  it('audio auto keeps own audio over TCP only, and asks for 7882/udp', () => {
    const b = box();
    const { out } = b.run(INSTALL, ['--yes'], {
      ...BASE_ENV,
      TWRING_LINK_AGENTS: 'no',
      STUB_PROBE: '{"tcp7881":{"ok":true},"udp7882":{"ok":false}}',
    });
    expect(out).toContain('ufw allow 7882/udp');
    expect(out).not.toContain('ufw allow 7881/tcp');
    expect(readFileSync(`${b.root}/compose.yml`, 'utf8')).toContain("TWRING_AUDIO: 'own'");
  });

  it('picks an internal network that does not overlap existing routes or Docker networks', () => {
    const b = box();
    b.run(INSTALL, ['--yes'], {
      ...BASE_ENV,
      TWRING_LINK_AGENTS: 'no',
      STUB_ROUTES: 'default 172.29.0.0/16',
      STUB_NETWORKS: '172.30.0.0/16',
    });
    const compose = parse(readFileSync(`${b.root}/compose.yml`, 'utf8')) as {
      services: Record<
        string,
        {
          environment?: Record<string, string>;
          networks?: Record<string, { ipv4_address: string }>;
        }
      >;
      networks: { twring: { ipam: { config: { subnet: string }[] } } };
    };
    expect(compose.networks.twring.ipam.config[0]!.subnet).toBe('10.229.41.0/24');
    expect(compose.services.caddy!.networks!.twring!.ipv4_address).toBe('10.229.41.2');
    expect(compose.services.twring!.environment!.TRUST_PROXY).toBe('10.229.41.2');
  });

  it('in a sandbox writes the Twring-audio compose file without Caddy or LiveKit', () => {
    const b = box();
    const { status } = b.run(INSTALL, ['--yes'], {
      ...BASE_ENV,
      TWRING_LINK_AGENTS: 'no',
      TWRING_PUBLIC_URL: 'https://abc123.sandbox.example.dev',
      TWRING_LISTEN_PORT: '3000',
      TWRING_TRUSTED_PROXIES: '10.0.0.0/8',
    });
    expect(status).toBe(0);
    const compose = parse(readFileSync(`${b.root}/compose.yml`, 'utf8')) as {
      services: Record<string, { environment?: Record<string, string>; ports?: string[] }>;
    };
    expect(Object.keys(compose.services)).toEqual(['twring']);
    const env = compose.services.twring!.environment!;
    expect(env.CORD_PUBLIC_URL).toBe('https://abc123.sandbox.example.dev');
    expect(env.TRUST_PROXY).toBe('10.0.0.0/8');
    expect(env.PORT).toBe('3000');
    expect(existsSync(`${b.root}/Caddyfile`)).toBe(false);
    expect(b.docker().some((c) => c.args.includes('dist/probe-echo.js'))).toBe(false);
    expect(b.docker().some((c) => c.args.includes('ip'))).toBe(false);
    const register = b.docker().find((c) => c.args.includes('register'))!;
    expect(register.args).toContain('https://abc123.sandbox.example.dev');
  });

  it('defaults the sandbox proxy trust to false', () => {
    const b = box();
    b.run(INSTALL, ['--yes'], {
      ...BASE_ENV,
      TWRING_LINK_AGENTS: 'no',
      TWRING_PUBLIC_URL: 'https://abc123.sandbox.example.dev',
    });
    expect(readFileSync(`${b.root}/compose.yml`, 'utf8')).toContain("TRUST_PROXY: 'false'");
  });

  it('explains instead of failing when Node is missing for agent linking', () => {
    if (onPath('node')) return;
    const b = box({ without: ['node'] });
    const { status, out } = b.run(INSTALL, ['--yes'], BASE_ENV);
    expect(status).toBe(0);
    expect(out).toContain('Node.js');
    expect(out).toContain('twring link');
  });
});

const SCRIPT = existsSync(INSTALL) ? readFileSync(INSTALL, 'utf8') : '';
const FAST = { ...BASE_ENV, TWRING_LINK_AGENTS: 'no' };
const created = (b: ReturnType<typeof box>) =>
  b
    .docker()
    .some(
      (c) =>
        ['volume', 'run', 'compose'].includes(c.args[0]!) &&
        c.args[1] !== 'version' &&
        c.args[1] !== 'inspect',
    );

describe.skipIf(!canRun)('install.sh under curl | sh', { timeout: 60_000 }, () => {
  it('a stdin-reading command cannot eat the rest of the piped script', () => {
    const b = box();
    const { status, out } = b.piped(SCRIPT, ['--yes'], { ...BASE_ENV, STUB_EXEC_READS_STDIN: '1' });
    expect(out).toContain('K7QM-2XPA');
    expect(status).toBe(0);
    expect(
      existsSync(`${b.dir}/exec-stdin`) ? readFileSync(`${b.dir}/exec-stdin`, 'utf8') : '',
    ).toBe('');
  });

  it('a truncated download does nothing at all', () => {
    const lines = SCRIPT.split('\n');
    for (const cut of [
      Math.floor(lines.length / 3),
      Math.floor(lines.length / 2),
      lines.length - 2,
    ]) {
      const b = box();
      b.piped(lines.slice(0, cut).join('\n') + '\n', ['--yes'], BASE_ENV);
      expect(b.calls()).toEqual([]);
      expect(existsSync(b.root)).toBe(false);
    }
  });

  it('downloads and checks the kit; a twring planted in the working directory never runs', () => {
    const b = box();
    const planted = `#!/bin/sh\necho planted >"${b.dir}/planted-ran"\n`;
    writeFileSync(`${b.dir}/twring`, planted);
    for (const name of [
      'compose.own.yml',
      'compose.twring.yml',
      'Caddyfile.tmpl',
      'livekit.yaml.tmpl',
    ]) {
      writeFileSync(`${b.dir}/${name}`, 'planted: true\n');
    }
    const { status } = b.piped(SCRIPT, ['--yes'], FAST);
    expect(status).toBe(0);
    expect(existsSync(`${b.dir}/planted-ran`)).toBe(false);
    expect(readFileSync(`${b.binDir}/twring`, 'utf8')).toBe(readFileSync(TWRING, 'utf8'));
    expect(
      b.calls().some((c) => c.cmd === 'curl' && c.args.some((a) => a.endsWith('/kit.tar.gz'))),
    ).toBe(true);
  });

  it.each([
    ['world-writable', '0 777'],
    ['group-writable', '0 775'],
    ['not owned by root', '1000 755'],
  ])('a kit beside install.sh in a %s folder is not trusted', (_label, statOut) => {
    const b = box();
    const kitDir = `${b.dir}/download`;
    mkdirSync(kitDir);
    copyFileSync(INSTALL, `${kitDir}/install.sh`);
    writeFileSync(`${kitDir}/twring`, `#!/bin/sh\necho planted >"${b.dir}/planted-ran"\n`);
    for (const name of KIT_FILES.filter((n) => n !== 'twring')) {
      copyFileSync(join(HERE, name), `${kitDir}/${name}`);
    }
    chmodSync(kitDir, 0o777);
    const { status } = b.run(`${kitDir}/install.sh`, ['--yes'], {
      ...FAST,
      STUB_KIT_STAT: statOut,
    });
    expect(status).toBe(0);
    expect(existsSync(`${b.dir}/planted-ran`)).toBe(false);
    expect(readFileSync(`${b.binDir}/twring`, 'utf8')).toBe(readFileSync(TWRING, 'utf8'));
    expect(
      b.calls().some((c) => c.cmd === 'curl' && c.args.some((a) => a.endsWith('/kit.tar.gz'))),
    ).toBe(true);
  });

  it('without --local-kit downloads the kit even beside install.sh in a root-owned folder', () => {
    const b = box();
    const { status } = b.run(INSTALL, ['--yes'], { ...FAST, STUB_KIT_STAT: '0 755' });
    expect(status).toBe(0);
    expect(
      b.calls().some((c) => c.cmd === 'curl' && c.args.some((a) => a.endsWith('/kit.tar.gz'))),
    ).toBe(true);
  });

  it('with --local-kit refuses a folder or file others can write to, and runs nothing from it', () => {
    const b = box();
    const kitDir = `${b.dir}/download`;
    mkdirSync(kitDir);
    copyFileSync(INSTALL, `${kitDir}/install.sh`);
    writeFileSync(`${kitDir}/twring`, `#!/bin/sh\necho planted >"${b.dir}/planted-ran"\n`);
    for (const name of KIT_FILES.filter((n) => n !== 'twring')) {
      copyFileSync(join(HERE, name), `${kitDir}/${name}`);
    }
    const { status, out } = b.run(`${kitDir}/install.sh`, ['--yes', '--local-kit'], {
      ...FAST,
      STUB_KIT_STAT: '0 775',
    });
    expect(status).toBe(1);
    expect(out).toContain('--local-kit: ');
    expect(out).toContain('others can change it');
    expect(existsSync(`${b.dir}/planted-ran`)).toBe(false);
    expect(created(b)).toBe(false);
  });

  it('uses the kit beside install.sh with --local-kit in a root-owned, not writable folder', () => {
    const b = box();
    const { status } = b.run(INSTALL, ['--yes', '--local-kit'], {
      ...FAST,
      STUB_KIT_STAT: '0 755',
    });
    expect(status).toBe(0);
    expect(
      b.calls().some((c) => c.cmd === 'curl' && c.args.some((a) => a.endsWith('/kit.tar.gz'))),
    ).toBe(false);
  });

  it('stops when the kit does not match its checksum, before creating anything', () => {
    const b = box();
    const { status, out } = b.piped(SCRIPT, ['--yes'], {
      ...FAST,
      STUB_VERSIONS: versions(OLD, { kit: `sha256:${'c'.repeat(64)}` }),
    });
    expect(status).toBe(1);
    expect(out).toMatch(/kit does not match/);
    expect(created(b)).toBe(false);
    expect(existsSync(b.root)).toBe(false);
  });

  it('every download is https only with TLS 1.2 or newer', () => {
    const b = box();
    b.piped(SCRIPT, ['--yes'], BASE_ENV);
    const curls = b.calls().filter((c) => c.cmd === 'curl');
    expect(curls.length).toBeGreaterThanOrEqual(3);
    for (const call of curls) {
      expect(call.args.slice(0, 4)).toEqual(['--proto', '=https', '--tlsv1.2', '-fsSL']);
    }
  });
});

describe.skipIf(!canRun)('install.sh checks and failures', { timeout: 60_000 }, () => {
  it('drops the speech key from the environment right after checking it', () => {
    const b = box();
    b.run(INSTALL, ['--yes'], FAST);
    const calls = b.calls();
    const check = calls.findIndex((c) => c.args.includes('dist/check-speech-key.js'));
    expect(calls[check]!.env).toEqual([`ENV TWRING_SPEECH_KEY=${SPEECH_KEY}`]);
    expect(calls.length).toBeGreaterThan(check + 5);
    expect(calls.slice(check + 1).filter((c) => c.env.length > 0)).toEqual([]);
    expect(readFileSync(`${b.root}/twring.env`, 'utf8')).toContain(
      `DEEPGRAM_API_KEY=${SPEECH_KEY}`,
    );
  });

  it.each(['1;x', '1/2', 'latest*', '1.0.0 '])('refuses TWRING_VERSION %j', (version) => {
    const b = box();
    const { status, out } = b.run(INSTALL, ['--yes'], { ...FAST, TWRING_VERSION: version });
    expect(status).toBe(1);
    expect(out).toContain('TWRING_VERSION');
    expect(created(b)).toBe(false);
  });

  it.each([
    'http://abc.sandbox.example.dev',
    'https://abc.sandbox.example.dev/path',
    'https://abc.sandbox.example.dev:8443',
    'https://user@abc.sandbox.example.dev',
  ])('refuses TWRING_PUBLIC_URL %j before creating anything', (url) => {
    const b = box();
    const { status, out } = b.run(INSTALL, ['--yes'], { ...FAST, TWRING_PUBLIC_URL: url });
    expect(status).toBe(1);
    expect(out).toContain('TWRING_PUBLIC_URL');
    expect(b.docker()).toEqual([]);
  });

  it('accepts a sandbox URL with port 443', () => {
    const b = box();
    const { status } = b.run(INSTALL, ['--yes'], {
      ...FAST,
      TWRING_PUBLIC_URL: 'https://abc.sandbox.example.dev:443',
    });
    expect(status).toBe(0);
  });

  it.each(['not-an-email', 'a b@example.com', 'owner@example'])(
    'refuses TWRING_EMAIL %j before creating anything',
    (email) => {
      const b = box();
      const { status, out } = b.run(INSTALL, ['--yes'], { ...FAST, TWRING_EMAIL: email });
      expect(status).toBe(1);
      expect(out).toContain('TWRING_EMAIL');
      expect(created(b)).toBe(false);
    },
  );

  it.each(['localhost', 'bad_domain.com', 'x.com/evil', '-x.example.com'])(
    'refuses TWRING_DOMAIN %j before creating anything',
    (domain) => {
      const b = box();
      const { status, out } = b.run(INSTALL, ['--yes'], { ...FAST, TWRING_DOMAIN: domain });
      expect(status).toBe(1);
      expect(out).toContain('TWRING_DOMAIN');
      expect(created(b)).toBe(false);
    },
  );

  it('a data volume left from before stops before any question, download or registration', () => {
    const b = box();
    const { status, out } = b.run(INSTALL, ['--yes'], { ...FAST, STUB_VOLUME_EXISTS: '1' });
    expect(status).toBe(1);
    expect(out).toContain('docker volume rm twring_twring-data');
    expect(out).toMatch(/ring service/);
    expect(b.calls().some((c) => c.cmd === 'curl')).toBe(false);
    expect(b.docker().some((c) => c.args.includes('register'))).toBe(false);
  });

  it('a failure after registering deletes that registration again, and says so', () => {
    const b = box();
    const { status, out } = b.run(INSTALL, ['--yes'], {
      ...FAST,
      // Every candidate network is taken: the install stops after registering.
      STUB_ROUTES: '10.0.0.0/8 172.16.0.0/12 192.168.0.0/16',
    });
    expect(status).toBe(1);
    const order = b.docker().map((c) => c.args.join(' '));
    const register = order.findIndex((a) => a.includes(' register '));
    const unregister = order.findIndex((a) => a.includes('unregister'));
    expect(register).toBeGreaterThanOrEqual(0);
    expect(unregister).toBeGreaterThan(register);
    expect(out).toMatch(/deleted this server's registration/);
  });

  it('a finished install, or a refused registration, deletes no registration', () => {
    const ok = box();
    expect(ok.run(INSTALL, ['--yes'], FAST).status).toBe(0);
    expect(ok.docker().some((c) => c.args.includes('unregister'))).toBe(false);
    const refused = box();
    refused.run(INSTALL, ['--yes'], { ...FAST, STUB_REGISTER_FAIL: 'no' });
    expect(refused.docker().some((c) => c.args.includes('unregister'))).toBe(false);
  });

  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.9', '100.64.0.1', '169.254.1.1'])(
    'refuses a non-public address from the ring service (%s), before registering',
    (ip) => {
      const b = box();
      const { status, out } = b.run(INSTALL, ['--yes'], { ...FAST, STUB_IP: ip });
      expect(status).toBe(1);
      expect(out).toContain(
        "Twring's ring service could not see this server's public address. Set TWRING_DOMAIN and try again.",
      );
      expect(b.docker().some((c) => c.args.includes('register'))).toBe(false);
    },
  );

  it('checks HTTPS up to 3 times before printing firewall help', () => {
    const b = box();
    b.run(INSTALL, ['--yes'], {
      ...FAST,
      STUB_WEB_PROBE: '{"http":{"ok":true},"https":{"ok":false}}',
    });
    expect(
      b.docker().filter((c) => c.args.includes('probe') && c.args.includes('http,https')),
    ).toHaveLength(3);
  });

  it('shows the ring service refusal reason when registering fails', () => {
    const b = box();
    const { status, out } = b.run(INSTALL, ['--yes'], {
      ...FAST,
      STUB_REGISTER_FAIL: 'The ring service answered 403 (/v1/installs): This email is blocked.',
    });
    expect(status).toBe(1);
    expect(out).toContain('This email is blocked.');
  });

  it('stops clearly when openssl is missing or fails, before creating anything', () => {
    const b = box({ extra: { openssl: '#!/bin/sh\nexit 127\n' } });
    // The local kit, so the first use of openssl is the server key (a downloaded kit is checked
    // with openssl too, and stops there with the kit message).
    const { status, out } = b.run(INSTALL, ['--yes', '--local-kit'], FAST);
    expect(status).toBe(1);
    expect(out).toMatch(/openssl/);
    expect(b.docker().some((c) => c.args[0] === 'volume' && c.args[1] === 'create')).toBe(false);
  });

  it('stops when the server key did not land in the volume', () => {
    const b = box({
      extra: {
        // genpkey prints nothing: the key file in the volume stays empty.
        openssl: `#!/bin/sh\n[ "$1" = genpkey ] && exit 0\nexec "${SYSTEM_PATH[0]}/openssl" "$@"\n`,
      },
    });
    const { status, out } = b.run(INSTALL, ['--yes'], FAST);
    expect(status).toBe(1);
    expect(out).toMatch(/server key/);
    expect(existsSync(`${b.root}/twring.env`)).toBe(false);
  });

  it('names the program already using port 80 or 443, before creating anything', () => {
    const b = box();
    const { status, out } = b.run(INSTALL, ['--yes'], {
      ...FAST,
      STUB_SS: 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))',
    });
    expect(status).toBe(1);
    expect(out).toContain('nginx');
    expect(out).toContain('80');
    expect(created(b)).toBe(false);
  });

  it('does not check 80/443 in a sandbox', () => {
    const b = box();
    const { status } = b.run(INSTALL, ['--yes'], {
      ...FAST,
      TWRING_PUBLIC_URL: 'https://abc.sandbox.example.dev',
      STUB_SS: 'LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("caddy",pid=9,fd=6))',
    });
    expect(status).toBe(0);
  });

  it('shows Docker Compose errors and the commands to recover', () => {
    const b = box();
    const { status, out } = b.run(INSTALL, ['--yes'], {
      ...FAST,
      STUB_UP_FAIL: 'driver failed programming external connectivity',
    });
    expect(status).toBe(1);
    expect(out).toContain('driver failed programming external connectivity');
    expect(out).toContain('twring start');
    expect(out).toContain('twring pair --admin');
  });

  // dash (Ubuntu's sh) exits on a failed redirect of a special builtin like `:`, silently and with
  // status 2, so the no-terminal check itself must not be one.
  it('without --yes or a terminal, names the missing setting instead of dying silently', () => {
    const b = box();
    const { TWRING_SPEECH_KEY: _key, ...env } = FAST;
    void _key;
    const { status, out } = b.run(INSTALL, [], env);
    expect(status).toBe(1);
    expect(out).toContain(
      'TWRING_SPEECH_KEY is not set, and there is no terminal here to ask on. Set it in the environment, or run this in a terminal.',
    );
    expect(out).not.toContain('--yes');
  });

  it('with --yes, a missing setting says to set it or drop --yes', () => {
    const b = box();
    const { TWRING_SPEECH_KEY: _key, ...env } = FAST;
    void _key;
    const { status, out } = b.run(INSTALL, ['--yes'], env);
    expect(status).toBe(1);
    expect(out).toContain(
      'TWRING_SPEECH_KEY is not set. Set it, or run without --yes to be asked.',
    );
  });

  it('when the server never starts, says so instead of blaming ports 80 and 443', () => {
    const b = box();
    const { status, out } = b.run(INSTALL, ['--yes'], { ...FAST, STUB_EXEC_DOWN: 'yes' });
    expect(status).toBe(1);
    expect(out).toContain('Twring did not report ready');
    expect(out).toContain(
      'The Twring server is not running, so ports 80 and 443 could not be checked.',
    );
    expect(out).not.toContain('ufw allow');
    expect(out).toContain('twring logs');
  });

  it('when ready but 80/443 are closed from outside, prints ufw and firewalld lines before pairing', () => {
    const b = box();
    const { status, out } = b.run(INSTALL, ['--yes'], {
      ...FAST,
      STUB_WEB_PROBE: '{"http":{"ok":false},"https":{"ok":false}}',
    });
    expect(status).toBe(0);
    expect(out).toContain('ufw allow 80/tcp');
    expect(out).toContain('ufw allow 443/tcp');
    expect(out).toContain('firewall-cmd --permanent --add-port=443/tcp');
    expect(out).toMatch(/cloud provider/);
    expect(out.indexOf('ufw allow 443/tcp')).toBeLessThan(out.indexOf('K7QM-2XPA'));
    expect(b.docker().some((c) => c.args.includes('probe') && c.args.includes('http,https'))).toBe(
      true,
    );
  });

  it('prints the admin QR from the image (no qrencode on the host)', () => {
    const b = box();
    const { out } = b.run(INSTALL, ['--yes'], FAST);
    expect(out).toContain('[QR]');
    expect(out).toContain('twring://pair?server=');
    expect(b.docker().some((c) => c.args.slice(-3).join(' ') === 'code --admin --qr')).toBe(true);
  });
});

describe.skipIf(!canRun)('agent linking as a person, not root', { timeout: 60_000 }, () => {
  it('uses TWRING_AGENT_USER when there is no SUDO_USER', () => {
    const b = box();
    const { SUDO_USER: _drop, ...env } = BASE_ENV;
    void _drop;
    b.run(INSTALL, ['--yes'], { ...env, TWRING_AGENT_USER: 'bob' });
    const link = b.calls().find((c) => c.cmd === 'runuser')!;
    expect(link.args.slice(0, 3)).toEqual(['-l', 'bob', '-c']);
    expect(link.args[3]).toContain(`cd '${b.home}/bob' && `);
  });

  it('with --yes and no user, skips linking and prints twring link --user', () => {
    const b = box();
    const { SUDO_USER: _drop, ...env } = BASE_ENV;
    void _drop;
    const { status, out } = b.run(INSTALL, ['--yes'], env);
    expect(status).toBe(0);
    expect(out).toContain('twring link --user');
    expect(b.calls().some((c) => c.cmd === 'runuser' || c.cmd === 'node')).toBe(false);
    expect(b.docker().some((c) => c.args.includes('connector-code'))).toBe(false);
  });

  it('refuses root and an unknown user', () => {
    const b = box();
    const root = b.run(INSTALL, ['--yes'], {
      ...BASE_ENV,
      SUDO_USER: '',
      TWRING_AGENT_USER: 'root',
    });
    expect(root.out).toContain('twring link --user');
    expect(b.calls().some((c) => c.cmd === 'runuser')).toBe(false);
    const c = box();
    const unknown = c.run(INSTALL, ['--yes'], { ...BASE_ENV, STUB_NOUSER: 'alice' });
    expect(unknown.out).toMatch(/no user named alice/i);
    expect(c.calls().some((x) => x.cmd === 'runuser')).toBe(false);
  });

  it('stops when the connector does not match its checksum', () => {
    const b = box();
    const { out } = b.run(INSTALL, ['--yes'], { ...BASE_ENV, STUB_CONNECT: 'tampered' });
    expect(out).toMatch(/connector does not match/);
    expect(b.calls().some((c) => c.cmd === 'runuser')).toBe(false);
    expect(existsSync(`${b.root}/twring-connect.mjs`)).toBe(false);
  });

  it('runs the connector with no stdin', () => {
    const b = box();
    b.piped(SCRIPT, ['--yes'], { ...BASE_ENV, STUB_EXEC_READS_STDIN: '1' });
    expect(b.calls().some((c) => c.cmd === 'runuser')).toBe(true);
  });
});

/** An installed server as the installer leaves it, for the `twring` command tests. */
function installed() {
  const b = box();
  mkdirSync(b.root, { recursive: true });
  writeFileSync(`${b.root}/twring.env`, 'TWRING_ADMIN_TOKEN=x\n');
  writeFileSync(
    `${b.root}/install.conf`,
    [
      `TWRING_IMAGE='${REPO}@${OLD}'`,
      "TWRING_VERSION='latest'",
      "TWRING_SETUP='own'",
      "TWRING_AUDIO='own'",
      "TWRING_ADDRESS='https://203-0-113-7.sslip.io'",
      "TWRING_PROBE_ADDRESS='203-0-113-7.sslip.io'",
      '',
    ].join('\n'),
  );
  writeFileSync(`${b.root}/compose.yml`, `services:\n  twring:\n    image: '${REPO}@${OLD}'\n`);
  return b;
}

describe.skipIf(!canRun)('twring', { timeout: 60_000 }, () => {
  it('pair calls the admin command for a member code', () => {
    const b = installed();
    const { status, out } = b.run(TWRING, ['pair']);
    expect(status).toBe(0);
    const exec = b.docker().find((c) => c.args.includes('code'))!;
    expect(exec.args.slice(-6)).toEqual([
      'twring',
      'node',
      'dist/admin-cli.js',
      'code',
      'member',
      '--qr',
    ]);
    expect(exec.args).toContain('--env-file');
    expect(out).toContain('K7QM-2XPA');
  });

  it('people remove --purge passes --purge to the server', () => {
    const b = installed();
    const { status } = b.run(TWRING, ['people', 'remove', 'per_1', '--purge']);
    expect(status).toBe(0);
    const exec = b.docker().find((c) => c.args.includes('remove'))!;
    expect(exec.args.slice(-3)).toEqual(['remove', 'per_1', '--purge']);
  });

  it('people remove without --purge keeps their data', () => {
    const b = installed();
    b.run(TWRING, ['people', 'remove', 'per_1']);
    const exec = b.docker().find((c) => c.args.includes('remove'))!;
    expect(exec.args.slice(-2)).toEqual(['remove', 'per_1']);
  });

  it('uninstall deletes the install at the ring service before removing the data', () => {
    const b = installed();
    const { status, out } = b.run(TWRING, ['uninstall', '--yes']);
    expect(status).toBe(0);
    const calls = b.docker();
    const unregister = calls.findIndex((c) => c.args.includes('unregister'));
    const down = calls.findIndex((c) => c.args.includes('down'));
    expect(unregister).toBeGreaterThanOrEqual(0);
    expect(unregister).toBeLessThan(down);
    expect(calls[unregister]!.args).toContain('--env-file');
    expect(out).not.toContain('support@twring.com');
  });

  it('uninstall still removes everything when the ring service cannot be reached, and says so', () => {
    const b = installed();
    const { status, out } = b.run(TWRING, ['uninstall', '--yes'], { STUB_UNREGISTER_FAIL: '1' });
    expect(status).toBe(0);
    expect(out).toContain('support@twring.com');
    expect(b.docker().some((c) => c.args.includes('down'))).toBe(true);
  });

  it('uninstall --keep-data keeps the install at the ring service', () => {
    const b = installed();
    b.run(TWRING, ['uninstall', '--keep-data', '--yes']);
    expect(b.docker().some((c) => c.args.includes('unregister'))).toBe(false);
  });

  it('link: an explicit TWRING_AGENT_USER wins over SUDO_USER', () => {
    const b = installed();
    b.run(TWRING, ['link'], {
      STUB_FIRST_ADMIN: 'per_admin',
      SUDO_USER: 'alice',
      TWRING_AGENT_USER: 'bob',
    });
    const link = b.calls().find((c) => c.cmd === 'runuser')!;
    expect(link.args.slice(0, 2)).toEqual(['-l', 'bob']);
  });

  it('register registers the same server again with the email given, at its address', () => {
    const b = installed();
    const { status, out } = b.run(TWRING, ['register', '--yes'], {
      TWRING_EMAIL: 'new@example.com',
    });
    expect(status).toBe(0);
    const call = b.docker().find((c) => c.args.includes('register'))!;
    expect(call.args[0]).toBe('run');
    expect(call.args).toContain('--env-file');
    expect(call.args.slice(-7)).toEqual([
      'register',
      '--email',
      'new@example.com',
      '--news',
      'no',
      '--address',
      '203-0-113-7.sslip.io',
    ]);
    expect(out).toContain('new@example.com');
  });

  it('register with --yes and no email stops and says what to set', () => {
    const b = installed();
    const { status, out } = b.run(TWRING, ['register', '--yes'], {});
    expect(status).not.toBe(0);
    expect(out).toContain('TWRING_EMAIL');
    expect(b.docker().some((c) => c.args.includes('register'))).toBe(false);
  });

  it.each([
    [
      '{"state":"active","paid_until":"2027-06-30T00:00:00.000Z"}',
      'Ring service: active until 2027-06-30',
    ],
    [
      '{"state":"unverified","paid_until":"2027-06-30T00:00:00.000Z"}',
      'Ring service: active until 2027-06-30. Confirm the email Twring sent you within 7 days, or rings pause.',
    ],
    [
      '{"state":"paused","paid_until":"2027-06-30T00:00:00.000Z"}',
      'Ring service: paused until your email is confirmed',
    ],
    ['{"state":"expired","paid_until":"2026-06-30T00:00:00.000Z"}', 'Ring service: ended'],
    ['{"state":"unknown"}', 'Ring service: unknown'],
    ['{"state":"unregistered"}', 'Ring service: not registered: run twring register'],
  ])('status prints the ring service in one line (%s)', (ring, line) => {
    const b = installed();
    const { out } = b.run(TWRING, ['status'], {
      STUB_STATUS: `{"server_id":"srv_abc","people":1,"admins":1,"devices":1,"ring_service":${ring}}`,
    });
    expect(out).toContain(line);
  });

  it('audio check --full without --yes or a terminal asks for --yes (dash, no silent exit)', () => {
    const b = installed();
    const { status, out } = b.run(TWRING, ['audio', 'check', '--full']);
    expect(status).toBe(1);
    expect(out).toContain('Add --yes to confirm');
    expect(b.docker().some((c) => c.args.includes('stop'))).toBe(false);
  });

  it('status counts people and phones in plain words, not the raw answer', () => {
    const b = installed();
    const { out } = b.run(TWRING, ['status'], {
      STUB_STATUS:
        '{"server_id":"srv_abc","people":3,"admins":1,"devices":4,"ring_service":{"state":"active","paid_until":"2027-06-30T00:00:00.000Z"}}',
    });
    expect(out).toContain('People: 3 (1 admin), phones: 4');
    expect(out).toContain('Server id: srv_abc');
    expect(out).not.toContain('"server_id"');
  });

  it('status says when call media runs over TCP only', () => {
    const b = installed();
    writeFileSync(
      `${b.root}/install.conf`,
      `${readFileSync(`${b.root}/install.conf`, 'utf8')}TWRING_MEDIA='tcp'\n`,
    );
    const { out } = b.run(TWRING, ['status']);
    expect(out).toContain('Call audio: this server (media over TCP only)');
  });

  it('link does not share agents unless asked; link --shared does', () => {
    const b = installed();
    b.run(TWRING, ['link'], { STUB_FIRST_ADMIN: 'per_admin', SUDO_USER: 'alice' });
    expect(b.calls().find((c) => c.cmd === 'runuser')!.args[3]).not.toContain('--shared');
    const s = installed();
    s.run(TWRING, ['link', '--shared'], { STUB_FIRST_ADMIN: 'per_admin', SUDO_USER: 'alice' });
    expect(s.calls().find((c) => c.cmd === 'runuser')!.args[3]).toMatch(/ --shared$/);
  });

  it('link --user with no name prints the hint, not a shell error', () => {
    const b = installed();
    const { out } = b.run(TWRING, ['link', '--user'], { STUB_FIRST_ADMIN: 'per_admin' });
    expect(out).toContain('twring link --user <their login name>');
    expect(out).not.toMatch(/shift/i);
    expect(b.calls().some((c) => c.cmd === 'runuser')).toBe(false);
  });

  it('a rolled-back update removes the plaintext data copy too', () => {
    const b = installed();
    b.run(TWRING, ['update'], {
      STUB_VERSIONS: versions(NEW),
      STUB_READY_BAD: 'b'.repeat(64),
    });
    expect(existsSync(`${b.root}/rollback/data.tar`)).toBe(false);
  });

  it('pair --admin asks for an admin code', () => {
    const b = installed();
    b.run(TWRING, ['pair', '--admin']);
    expect(b.docker().some((c) => c.args.slice(-3).join(' ') === 'code --admin --qr')).toBe(true);
  });

  it('update pins the new digest from versions.json', () => {
    const b = installed();
    const { status } = b.run(TWRING, ['update'], { STUB_VERSIONS: versions(NEW) });
    expect(status).toBe(0);
    expect(readFileSync(`${b.root}/compose.yml`, 'utf8')).toContain(`${REPO}@${NEW}`);
    expect(readFileSync(`${b.root}/install.conf`, 'utf8')).toContain(`${REPO}@${NEW}`);
    expect(b.docker().some((c) => c.args[0] === 'pull' && c.args[1] === `${REPO}@${NEW}`)).toBe(
      true,
    );
  });

  it('update refuses an image whose digest does not match', () => {
    const b = installed();
    const before = sha(`${b.root}/compose.yml`);
    const { status, out } = b.run(TWRING, ['update'], {
      STUB_VERSIONS: versions(NEW),
      STUB_DIGEST_MISMATCH: '1',
    });
    expect(status).toBe(1);
    expect(out).toMatch(/does not match the published digest/);
    expect(sha(`${b.root}/compose.yml`)).toBe(before);
  });

  it('update rolls back image and data when the new version is not ready', () => {
    const b = installed();
    const { status, out } = b.run(TWRING, ['update'], {
      STUB_VERSIONS: versions(NEW),
      STUB_READY_BAD: 'b'.repeat(64),
      STUB_DATA: 'before-update',
    });
    expect(status).toBe(1);
    expect(out).toMatch(/Rolled back/);
    expect(readFileSync(`${b.root}/compose.yml`, 'utf8')).toContain(`${REPO}@${OLD}`);
    expect(readFileSync(`${b.root}/install.conf`, 'utf8')).toContain(`${REPO}@${OLD}`);
    expect(readFileSync(`${b.dir}/restored-data.tar`, 'utf8')).toBe('DATA:before-update\n');
  });

  it('update says so when already on the newest digest', () => {
    const b = installed();
    const { status, out } = b.run(TWRING, ['update']);
    expect(status).toBe(0);
    expect(out).toContain('up to date');
    expect(b.docker().some((c) => c.args[0] === 'pull')).toBe(false);
  });

  it('a successful update removes the plaintext data copy', () => {
    const b = installed();
    const { status } = b.run(TWRING, ['update'], { STUB_VERSIONS: versions(NEW) });
    expect(status).toBe(0);
    expect(b.docker().some((c) => c.args.includes('/backup/data.tar'))).toBe(true);
    expect(existsSync(`${b.root}/rollback/data.tar`)).toBe(false);
  });

  it('update refuses a version name that is not letters, digits and dots', () => {
    const b = installed();
    const { status, out } = b.run(TWRING, ['update'], { TWRING_VERSION_OVERRIDE: '1|x' });
    expect(status).toBe(1);
    expect(out).toContain('TWRING_VERSION');
    expect(b.calls().some((c) => c.cmd === 'curl')).toBe(false);
  });

  it('link starts the connector from the person’s home, in a login shell, with XDG_RUNTIME_DIR', () => {
    const b = installed();
    mkdirSync(`${b.dir}/home/dave`, { recursive: true });
    mkdirSync(`${b.dir}/run/user/1000`, { recursive: true });
    const { status } = b.run(TWRING, ['link', '--user', 'dave'], {
      STUB_FIRST_ADMIN: 'per_admin',
      STUB_HOME_BASE: b.home,
      TWRING_RUN_USER_DIR: `${b.dir}/run/user`,
    });
    expect(status).toBe(0);
    const link = b.calls().find((c) => c.cmd === 'runuser')!;
    // -l: the person's login shell sets their PATH (~/.local/bin, nvm) and HOME.
    expect(link.args.slice(0, 3)).toEqual(['-l', 'dave', '-c']);
    expect(link.cwd).toBe(
      realpathSync.native(`${b.dir}/home/dave`).replaceAll(String.fromCharCode(92), '/'),
    );
    expect(link.args[3]).toMatch(
      new RegExp(`^cd '${b.home}/dave' && XDG_RUNTIME_DIR='${b.dir}/run/user/1000' exec node `),
    );
  });

  it('link leaves XDG_RUNTIME_DIR alone when the folder does not exist', () => {
    const b = installed();
    b.run(TWRING, ['link', '--user', 'erin'], {
      STUB_FIRST_ADMIN: 'per_admin',
      TWRING_RUN_USER_DIR: `${b.dir}/no-such-run`,
    });
    const link = b.calls().find((c) => c.cmd === 'runuser')!;
    expect(link.args[3]).not.toContain('XDG_RUNTIME_DIR');
  });

  it.each(['bad;name', 'x|y', '-rf', 'a b', '$(id)'])('link refuses the login name %j', (name) => {
    const b = installed();
    const { status, out } = b.run(TWRING, ['link', '--user', name], {
      STUB_FIRST_ADMIN: 'per_admin',
    });
    expect(status).toBe(0);
    expect(out).toContain('is not a login name');
    expect(b.calls().some((c) => c.cmd === 'runuser')).toBe(false);
  });

  it('link --user runs the connector as that person with their home', () => {
    const b = installed();
    const { status } = b.run(TWRING, ['link', '--user', 'carol'], {
      STUB_FIRST_ADMIN: 'per_admin',
    });
    expect(status).toBe(0);
    const link = b.calls().find((c) => c.cmd === 'runuser')!;
    expect(link.args.slice(0, 3)).toEqual(['-l', 'carol', '-c']);
    expect(link.args[3]).toContain(`exec node '${b.root}/twring-connect.mjs' setup`);
  });

  it.skipIf(WIN)('backup files are readable by root only', () => {
    const b = installed();
    const file = `${b.dir}/modes.tar.enc`;
    b.run(TWRING, ['backup', file], { TWRING_BACKUP_PASSPHRASE: 'pw' });
    expect(mode(file)).toBe(0o600);
    expect(mode(`${file}.hmac`)).toBe(0o600);
  });

  it('backup refuses an empty passphrase', () => {
    const b = installed();
    const { status, out } = b.run(TWRING, ['backup', '--yes'], { TWRING_BACKUP_PASSPHRASE: '' });
    expect(status).toBe(1);
    expect(out).toMatch(/needs a passphrase/);
  });

  describe('backup and restore', () => {
    const b = installed();
    const file = `${b.dir}/server.tar.enc`;
    const PASS = 'correct horse battery staple';
    const backup = b.run(TWRING, ['backup', file], {
      TWRING_BACKUP_PASSPHRASE: PASS,
      STUB_DATA: 'people-and-keys',
    });

    it('writes the encrypted file and an HMAC-SHA256 of it from a passphrase-derived key', () => {
      expect(backup.status).toBe(0);
      const [tag, salt, mac] = readFileSync(`${file}.hmac`, 'utf8').trim().split(' ');
      expect(tag).toBe('twring-backup-hmac-v1');
      const key = pbkdf2Sync(PASS, Buffer.from(salt!, 'hex'), 600_000, 48, 'sha256').subarray(
        0,
        32,
      );
      expect(mac).toBe(createHmac('sha256', key).update(readFileSync(file)).digest('hex'));
      expect(readFileSync(file).subarray(0, 8).toString()).toBe('Salted__');
      for (const call of b.calls()) expect(call.args.join(' ')).not.toContain(PASS);
    });

    it('restores a good backup', () => {
      const { status } = b.run(TWRING, ['restore', file, '--yes'], {
        TWRING_BACKUP_PASSPHRASE: PASS,
      });
      expect(status).toBe(0);
      expect(readFileSync(`${b.dir}/restored-data.tar`, 'utf8')).toBe('DATA:people-and-keys\n');
    });

    it('refuses a tampered backup before decrypting anything', () => {
      const tampered = `${b.dir}/tampered.tar.enc`;
      const bytes = readFileSync(file);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      writeFileSync(tampered, bytes);
      copyFileSync(`${file}.hmac`, `${tampered}.hmac`);
      const { status, out } = b.run(TWRING, ['restore', tampered, '--yes'], {
        TWRING_BACKUP_PASSPHRASE: PASS,
      });
      expect(status).toBe(1);
      expect(out).toMatch(/does not match its check file/);
    });

    it('refuses the wrong passphrase', () => {
      const { status } = b.run(TWRING, ['restore', file, '--yes'], {
        TWRING_BACKUP_PASSPHRASE: 'wrong',
      });
      expect(status).toBe(1);
    });
  });
});
