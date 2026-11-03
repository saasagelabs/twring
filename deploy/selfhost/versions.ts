/**
 * The self-host version list, `apps/site/selfhost/versions.json`, as the installer reads it:
 *
 *   { "images": { "1.2.0": "sha256:..", "1": "sha256:..", "latest": "sha256:.." },
 *     "kit": "sha256:<kit.tar.gz>", "connect": "sha256:<twring-connect.mjs>" }
 *
 * `latest` and each major (`"1"`) always point at the highest semver published, recomputed on
 * every publish. Run by `scripts/publish-image.sh` with Node's type stripping:
 *
 *   node deploy/selfhost/versions.ts check <file> <version>
 *   node deploy/selfhost/versions.ts record <file> <version> <digest>
 *   node deploy/selfhost/versions.ts set <file> kit|connect <digest>
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface Versions {
  images: Record<string, string>;
  kit?: string;
  connect?: string;
}

export class VersionsError extends Error {}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function parsed(current: unknown): Versions {
  if (current === undefined) return { images: {} };
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    throw new VersionsError('versions.json is not an object.');
  }
  const { images, kit, connect, ...rest } = current as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    throw new VersionsError(`versions.json has unknown keys: ${Object.keys(rest).join(', ')}.`);
  }
  if (typeof images !== 'object' || images === null || Array.isArray(images)) {
    throw new VersionsError('versions.json has no images map.');
  }
  for (const value of [...Object.values(images as Record<string, unknown>), kit, connect]) {
    if (value !== undefined && (typeof value !== 'string' || !DIGEST.test(value))) {
      throw new VersionsError('versions.json has a value that is not a sha256 digest.');
    }
  }
  return {
    images: { ...(images as Record<string, string>) },
    ...(kit !== undefined && { kit: kit as string }),
    ...(connect !== undefined && { connect: connect as string }),
  };
}

const parts = (version: string): number[] => SEMVER.exec(version)!.slice(1).map(Number);
function newer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/** Adds `version` and recomputes `latest` and every major from the exact versions. */
export function recordVersion(current: unknown, version: string, digest: string): Versions {
  if (!SEMVER.test(version)) throw new VersionsError(`${version} is not major.minor.patch.`);
  if (!DIGEST.test(digest)) throw new VersionsError(`${digest} is not a sha256 digest.`);
  const versions = parsed(current);
  if (Object.hasOwn(versions.images, version)) {
    throw new VersionsError(`Version ${version} is already recorded.`);
  }
  const exact: Record<string, string> = { [version]: digest };
  for (const [name, value] of Object.entries(versions.images)) {
    if (SEMVER.test(name)) exact[name] = value;
  }
  const best = new Map<string, string>();
  let latest: string | undefined;
  for (const name of Object.keys(exact)) {
    const major = String(parts(name)[0]);
    const known = best.get(major);
    if (known === undefined || newer(name, known)) best.set(major, name);
    if (latest === undefined || newer(name, latest)) latest = name;
  }
  const images: Record<string, string> = { ...exact };
  for (const [major, name] of best) images[major] = exact[name]!;
  images.latest = exact[latest!]!;
  return { ...versions, images };
}

/** Sets the checksum of the installer kit or the connector, keeping everything else. */
export function setFileDigest(current: unknown, name: 'kit' | 'connect', digest: string): Versions {
  if (name !== 'kit' && name !== 'connect') throw new VersionsError('Only kit or connect.');
  if (!DIGEST.test(digest)) throw new VersionsError(`${digest} is not a sha256 digest.`);
  return { ...parsed(current), [name]: digest };
}

function read(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new VersionsError(`${file} is not valid JSON.`);
  }
}

function write(file: string, versions: Versions): void {
  writeFileSync(`${file}.new`, `${JSON.stringify(versions, null, 2)}\n`);
  renameSync(`${file}.new`, file);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, file, a, b] = process.argv.slice(2);
  try {
    if (command === 'check' && file !== undefined && a !== undefined) {
      const versions = parsed(read(file));
      if (Object.hasOwn(versions.images, a))
        throw new VersionsError(`Version ${a} is already in ${file}.`);
    } else if (command === 'record' && file !== undefined && a !== undefined && b !== undefined) {
      write(file, recordVersion(read(file), a, b));
    } else if (command === 'set' && file !== undefined && a !== undefined && b !== undefined) {
      write(file, setFileDigest(read(file), a as 'kit' | 'connect', b));
    } else {
      console.error('Usage: versions.ts check|record|set <file> ...');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
