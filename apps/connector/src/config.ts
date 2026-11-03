import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { connectorIdSchema, inviteIdSchema } from '@twring/contracts';
import { z } from 'zod';

import { localAgentConfigSchema } from './agents';

// Internal directory name, kept for existing installs; it is not the public CLI name.
const CONFIG_DIR_NAME = 'cord-connect';

/**
 * The connector's saved pairing: server, connector id, token, and how to start each agent. The
 * token is a secret: the file is readable by this user only (mode 600 on macOS/Linux; on Windows
 * the per-user profile folder's ACL protects it). It is never printed.
 */
export const connectorConfigSchema = z.object({
  server: z.url(),
  connector_id: connectorIdSchema,
  token: z.string().regex(/^cct_[A-Za-z0-9_-]{43}$/),
  name: z.string().min(1).max(60),
  agents: z.array(localAgentConfigSchema).min(1),
});
export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CORD_CONNECT_CONFIG_DIR !== undefined && env.CORD_CONNECT_CONFIG_DIR !== '') {
    return env.CORD_CONNECT_CONFIG_DIR;
  }
  if (process.platform === 'win32' && env.APPDATA !== undefined) {
    return join(env.APPDATA, CONFIG_DIR_NAME);
  }
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, CONFIG_DIR_NAME);
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'config.json');
}

export async function loadConfig(path: string): Promise<ConnectorConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = connectorConfigSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${path} is damaged. Pair again with --code.`);
  return parsed.data;
}

/** Writes via a temp file (mode 600) and renames, so a crash never leaves half a token. */
export async function saveConfig(path: string, config: ConnectorConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

export async function deleteConfig(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Forgets the saved pairing only if it is still `connectorId`'s: a copy started before the user
 * paired this computer again must not delete the new pairing when its old one is revoked.
 */
export async function deleteConfigIfOwned(path: string, connectorId: string): Promise<boolean> {
  let saved: ConnectorConfig | undefined;
  try {
    saved = await loadConfig(path);
  } catch {
    return false; // Damaged: leave it for the user to see (the next run says to pair again).
  }
  if (saved?.connector_id !== connectorId) return false;
  await deleteConfig(path);
  return true;
}

/**
 * The Twring server used when neither `--server` nor `CORD_SERVER` names one: production. Setup
 * messages from the app always name their server, so staging links still go to staging.
 */
export const PRODUCTION_SERVER = 'https://api.twring.com';

export function defaultServer(env: NodeJS.ProcessEnv = process.env): string {
  // An empty variable counts as unset, so it never hides the next one.
  const fromEnv = [env.CORD_SERVER, env.CORD_CONNECT_SERVER].find(
    (v) => v !== undefined && v !== '',
  );
  return fromEnv ?? PRODUCTION_SERVER;
}

export const DEFAULT_SERVER = defaultServer();

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The gateway's base URL. https only, except plain http to this computer for local development:
 * the connector token must never cross a network in the clear.
 */
export function checkServerUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`"${input}" is not a web address. Use one like https://cord.example.com`);
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('The server address must start with https:// (http:// only for localhost).');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('The server address must not contain a user name or password.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

/** `https://host/base` → `wss://host/base/v1/connectors/socket`. */
export function socketUrl(server: URL): string {
  const url = new URL(server.toString());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/connectors/socket`;
  return url.toString();
}

export function apiUrl(server: URL, path: string): string {
  return `${server.toString().replace(/\/+$/, '')}${path}`;
}

/** This computer's last ring, kept so `ring --cancel` can cancel it (one invite id). */
const LAST_RING_FILE = 'last-ring';

export async function saveLastRing(dir: string, inviteId: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, LAST_RING_FILE), inviteId, { mode: 0o600 });
}

export async function readLastRing(dir: string): Promise<string | undefined> {
  const text = await readFile(join(dir, LAST_RING_FILE), 'utf8').catch(() => '');
  const parsed = inviteIdSchema.safeParse(text.trim());
  return parsed.success ? parsed.data : undefined;
}

export async function forgetLastRing(dir: string): Promise<void> {
  await rm(join(dir, LAST_RING_FILE), { force: true });
}
