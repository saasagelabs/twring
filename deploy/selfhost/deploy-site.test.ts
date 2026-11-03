import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// scripts/deploy-site.sh publishes the installer kit with the site. Its dry run builds the stage
// (install.sh, its checksum, selfhost/kit.tar.gz and versions.json) and prints it without ssh.

const WIN = process.platform === 'win32';
const BASH =
  process.env.TWRING_TEST_BASH ?? (WIN ? 'C:/Program Files/Git/usr/bin/bash.exe' : 'bash');
// Git's tools (sha256sum, tar, gzip) first, as install.test.ts does, so a Windows PATH with other
// tools of the same name (System32 tar) cannot stand in.
const PATH = WIN
  ? ['C:/Program Files/Git/usr/bin', process.env.PATH ?? ''].join(';')
  : (process.env.PATH ?? '');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'deploy-site.sh');
const KIT = [
  'Caddyfile.tmpl',
  'compose.own.yml',
  'compose.twring.yml',
  'livekit.yaml.tmpl',
  'twring',
];

describe('deploy-site.sh', () => {
  it('checks the self-hosting page, the installer and the version list after publishing', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    const checks = (/for path in ([^;]+); do/.exec(text)?.[1] ?? '').split(/\s+/);
    expect(checks).toEqual(
      expect.arrayContaining([
        '/self-hosting/',
        '/self-hosting/guide/',
        '/install.sh',
        '/selfhost/versions.json',
      ]),
    );
  });

  it('needs the built connector (DEPLOY_SITE_CONNECTOR) and never falls back to the live download', () => {
    const out = mkdtempSync(join(tmpdir(), 'deploy-site-'));
    dirs.push(out);
    const run = spawnSync(BASH, [SCRIPT, '--dry-run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH,
        DEPLOY_SITE_CONNECTOR: '',
        DEPLOY_SITE_VERSIONS: join(out, 'versions.json'),
        DEPLOY_SITE_STAGE_OUT: out,
      },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('DEPLOY_SITE_CONNECTOR');
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).not.toContain('-o "$CONNECTOR"');
    // After publishing, the live connector is compared with the built one.
    expect(text).toMatch(/downloads\/twring-connect\.mjs[\s\S]*CONNECT_DIGEST/);
  });

  it('stages install.sh with its checksum and the kit install.sh expects, and records digests', () => {
    const out = mkdtempSync(join(tmpdir(), 'deploy-site-'));
    dirs.push(out);
    const connector = join(out, 'twring-connect.mjs');
    writeFileSync(connector, 'console.log("connector")');
    const versions = join(out, 'versions.json');
    const before = JSON.stringify({ images: { latest: `sha256:${'c'.repeat(64)}` } });
    writeFileSync(versions, before);
    const run = spawnSync(BASH, [SCRIPT, '--dry-run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH,
        DEPLOY_SITE_CONNECTOR: connector,
        DEPLOY_SITE_VERSIONS: versions,
        DEPLOY_SITE_STAGE_OUT: out,
      },
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const listing = run.stdout;
    expect(listing).toMatch(/^\.\/install\.sh$/m);
    expect(listing).toMatch(/^\.\/install\.sh\.sha256$/m);
    expect(listing).toMatch(/^\.\/selfhost\/kit\.tar\.gz$/m);
    expect(listing).toMatch(/^\.\/selfhost\/versions\.json$/m);
    expect(listing).toMatch(/^\.\/self-hosting\/index\.html$/m);
    expect(listing).toMatch(/^\.\/self-hosting\/guide\/index\.html$/m);

    const tar = spawnSync('tar', ['-tzf', 'selfhost/kit.tar.gz'], {
      cwd: join(out, 'stage'),
      encoding: 'utf8',
      env: { ...process.env, PATH },
    });
    expect(tar.stdout.split('\n').filter(Boolean).sort()).toEqual(KIT);

    // A dry run leaves the source alone and records the digests in the stage only.
    expect(readFileSync(versions, 'utf8')).toBe(before);
    const recorded = JSON.parse(
      readFileSync(join(out, 'stage', 'selfhost', 'versions.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(recorded.images).toEqual({ latest: `sha256:${'c'.repeat(64)}` });
    expect(recorded.kit).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(recorded.connect).toMatch(/^sha256:[0-9a-f]{64}$/);
    const staged = readFileSync(join(out, 'stage', 'install.sh.sha256'), 'utf8');
    expect(staged).toMatch(/^[0-9a-f]{64} {2}install\.sh\n$/);
  }, 30_000);
});
