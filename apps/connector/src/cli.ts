import './node-check';

import { randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import {
  CONNECTOR_CLI_NAME,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_STORED_AGENT_MESSAGE_CHARS,
  claimResponseSchema,
  errorResponseSchema,
  relinkResponseSchema,
} from '@twring/contracts';

import { createAdapter, detectAgents, publicAgent, type LocalAgentConfig } from './agents';
import { checkOpenAIUrl } from './adapters/openai';
import { fetchRegistry, registryAgent, splitCommandLine, uniqueId } from './discovery';
import { doctor } from './doctor';
import { serveMcp } from './mcp';
import {
  apiUrl,
  checkServerUrl,
  configDir,
  configPath,
  defaultServer,
  deleteConfig,
  deleteConfigIfOwned,
  forgetLastRing,
  loadConfig,
  readLastRing,
  saveConfig,
  saveLastRing,
  socketUrl,
  type ConnectorConfig,
} from './config';
import {
  installClaudeHook,
  installCodexNotify,
  parseHookInput,
  uninstallClaudeHook,
  uninstallCodexNotify,
  type HookSource,
} from './hooks';
import { computerName, linkComputer, linkedLines, serverConflict } from './link';
import { uploadFile, UploadError } from './upload';
import { systemSpawn } from './process';
import { AgentPool } from './pool';
import { RelayClient } from './relay';
import {
  cancelLastRing,
  deliverBackgroundResult,
  MESSAGE_EXIT,
  envSessionScope,
  ringOwner,
  RING_EXIT,
  sendMessage,
} from './ring';
import { installSkill, refreshInstalledSkills, skillLines, skillTargets } from './skill-install';
import { WORDS_EXIT, addWords } from './words';
import {
  clearPid,
  clearStatus,
  installScript,
  installService,
  logPath,
  NOT_PAIRED_EXIT,
  prepareLog,
  readStatus,
  removeRunFiles,
  rotateLog,
  SERVICE_ENV,
  serviceSpecFor,
  stopRunning,
  stopService,
  systemHost,
  uninstallService,
  waitConnected,
  writePid,
  writeStatus,
} from './service';

const VERSION = '0.1.0';

const HELP = `${CONNECTOR_CLI_NAME} lets the Twring app on your phone call the AI agents on this computer.

Link this computer (scan the code it shows with the Twring app):
  npx ${CONNECTOR_CLI_NAME}

Run the same command later to reconnect.

Or pair with a code the app shows:
  npx ${CONNECTOR_CLI_NAME} --code XXXX-XXXX

Options:
  --code <code>          One-time pairing code from the app (Add agent, On my computer).
  --server <url>         Your Twring server (https://; http:// only for localhost). Default:
                         the CORD_SERVER variable, or Twring's own server.
  --name <name>          How this computer appears in the app (default: its host name).
  --agents <ids>         Which found agents to offer, e.g. claude-code,gemini (default: ask, or all).
  --command "<cmd>"      Offer any other agent: a command that reads your words on stdin and
                         prints its answer. Use with --command-label "My agent".
  --acp "<cmd>"          Offer an ACP agent; optional --acp-label <name>.
  --acp-agent <id>       Offer an agent from the public ACP registry.
  --openai-url <url>     Offer an OpenAI-compatible agent; optional --openai-model,
                         --openai-key-env and --openai-label.
  --cwd <folder>         Folder the agents work in (default: this folder).
  --claude-allow-edits   Let Claude Code edit files (default: read and search only).
  --acp-allow <kinds>    Tool kinds ACP agents may use when they ask, e.g. read,search
                         (default: every permission request is denied).
  --codex-sandbox <mode> read-only (default) or workspace-write.
  --forget               Remove this computer's saved pairing.
  --shared               Your own Twring server only: let everyone on it call these agents
                         (works with an admin's code; ignored otherwise). Shared agents keep
                         their own memory and files on this computer; everyone who uses them
                         may see what the agent remembers.

  npx ${CONNECTOR_CLI_NAME} agents [--registry]  List agents.
  npx ${CONNECTOR_CLI_NAME} doctor [--agent <id>] Test agent connections.
  npx ${CONNECTOR_CLI_NAME} mcp                Run the stdio MCP server.

Set it up to run in the background (starts with the machine, restarts by itself):
  node ${CONNECTOR_CLI_NAME}.mjs setup --code XXXX-XXXX [--server <url>]
  node ${CONNECTOR_CLI_NAME}.mjs setup                  (already linked: just install and start)
  --no-skill: don't add the Twring skill to your agents' skills folders.
  node ${CONNECTOR_CLI_NAME}.mjs uninstall [--forget]   (stop and remove it; --forget also unlinks)

Ring your phone (the agent needs you):
  npx ${CONNECTOR_CLI_NAME} ring "The tests pass; can I push?" [--agent <id>] [--session <ref>] [--wait]
  --wait waits for the answer; exit code 0 answered, 2 refused, 3 declined, 4 missed, 5 cancelled.
  npx ${CONNECTOR_CLI_NAME} ring --cancel   (stops your last ring if it is still ringing)

Send your phone a message (no ring):
  npx ${CONNECTOR_CLI_NAME} message "The nightly backup finished." [--agent <id>]
  npx ${CONNECTOR_CLI_NAME} message --file <path> [--file <path> ...] ["optional caption"]
  Up to five photos, PDFs or text files, 10 MB each.

Teach Twring words it mishears in calls and voice notes (names, people, projects, places):
  npx ${CONNECTOR_CLI_NAME} words "Gowri" "Lightsail" [--agent <id>]
  Up to 40 per agent; your owner can change them on the agent's Words page in the app.

Let Claude Code or Codex ring you by themselves:
  npx ${CONNECTOR_CLI_NAME} hooks install claude       (when Claude needs permission or input)
  npx ${CONNECTOR_CLI_NAME} hooks install claude --message
  npx ${CONNECTOR_CLI_NAME} hooks install codex --on-turn-complete   (after every Codex turn)
  npx ${CONNECTOR_CLI_NAME} hooks install codex --on-turn-complete --message
  npx ${CONNECTOR_CLI_NAME} hooks uninstall claude|codex
`;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): never {
  process.stderr.write(`${line}\n`);
  process.exit(1);
}

async function chooseAgents(
  found: LocalAgentConfig[],
  wanted: string | undefined,
  ask: boolean,
): Promise<LocalAgentConfig[]> {
  if (wanted !== undefined) {
    const ids = wanted
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const unknown = ids.filter((id) => !found.some((a) => a.id === id));
    if (unknown.length > 0) {
      throw new Error(
        `Not found on this computer: ${unknown.join(', ')}. Found: ${found.map((a) => a.id).join(', ') || 'none'}.`,
      );
    }
    return found.filter((a) => ids.includes(a.id));
  }
  if (!ask || found.length <= 1 || !process.stdin.isTTY) return found;
  print('Agents found on this computer:');
  found.forEach((agent, i) => print(`  ${i + 1}) ${agent.label}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(
        'Which should your phone be able to call? (Enter for all, or numbers like 1,3) ',
      )
    ).trim();
    if (answer === '') return found;
    const picked = answer
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10) - 1)
      .map((i) => found[i])
      .filter((a): a is LocalAgentConfig => a !== undefined);
    return picked.length > 0 ? picked : found;
  } finally {
    rl.close();
  }
}

/** The agents to offer: found on this computer, plus `--command`, narrowed by `--agents`. */
async function gatherAgents(
  values: Record<string, string | boolean | undefined>,
  ask = true,
  saved: LocalAgentConfig[] = [],
): Promise<LocalAgentConfig[]> {
  const cwd = (values.cwd as string | undefined) ?? process.cwd();
  const found = [
    ...saved,
    ...detectAgents(cwd).filter((agent) => !saved.some((item) => item.id === agent.id)),
  ];
  const command = values.command as string | undefined;
  if (command !== undefined) {
    const [bin, ...args] = splitCommandLine(command);
    if (bin !== undefined && bin !== '') {
      found.push({
        id: 'custom',
        label: ((values['command-label'] as string | undefined) ?? 'My agent').slice(0, 60),
        kind: 'command',
        command: bin,
        args,
        cwd,
      });
    }
  }
  if (typeof values.acp === 'string') {
    const [bin, ...args] = splitCommandLine(values.acp);
    const label = (values['acp-label'] as string | undefined) ?? bin!;
    found.push({
      id: uniqueId(
        label,
        found.map((item) => item.id),
      ),
      label: label.slice(0, 60),
      kind: 'acp',
      command: bin!,
      args,
      cwd,
    });
  }
  if (typeof values['acp-agent'] === 'string') {
    const { agent, version } = registryAgent(
      await fetchRegistry(),
      values['acp-agent'],
      cwd,
      found.map((item) => item.id),
    );
    print(`Will run: ${agent.command} ${agent.args.join(' ')} (package version ${version})`);
    found.push(agent);
  }
  if (typeof values['openai-url'] === 'string') {
    const label = (values['openai-label'] as string | undefined) ?? 'OpenAI agent';
    const keyEnv = values['openai-key-env'];
    if (typeof keyEnv === 'string' && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(keyEnv))
      throw new Error('Invalid key environment variable name.');
    found.push({
      id: uniqueId(
        label,
        found.map((item) => item.id),
      ),
      label: label.slice(0, 60),
      kind: 'openai',
      command: 'http',
      args: [],
      cwd,
      url: checkOpenAIUrl(values['openai-url']),
      model: (values['openai-model'] as string | undefined) ?? 'default',
      ...(typeof keyEnv === 'string' ? { keyEnv } : {}),
    });
  }
  const agents = (await chooseAgents(found, values.agents as string | undefined, ask)).map(
    (agent) => ({
      ...agent,
      ...(agent.kind === 'claude-code' &&
        values['claude-allow-edits'] === true && { allowEdits: true }),
      ...(agent.kind === 'acp' &&
        typeof values['acp-allow'] === 'string' && {
          allowKinds: values['acp-allow']
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== ''),
        }),
      ...(agent.kind === 'codex' &&
        values['codex-sandbox'] === 'workspace-write' && {
          codexSandbox: 'workspace-write' as const,
        }),
    }),
  );
  if (agents.length === 0) {
    throw new Error(
      'No agents found. Install Claude Code, Codex, Gemini CLI, or Hermes, or add one with --command "<your command>".',
    );
  }
  return agents;
}

function serverFrom(values: Record<string, string | boolean | undefined>): URL {
  return checkServerUrl((values.server as string | undefined) ?? defaultServer());
}

/** A refusal from the server, with its stable code (e.g. `pairing_invalid`). */
class ServerRefusal extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

/** Setup's requests to the server give up after this long: an agent must never hang on one. */
const SETUP_HTTP_TIMEOUT_MS = 20_000;

/**
 * Pairs with a code the phone showed (`--code`): the phone-first way. Throws on failure. With
 * `existing` (this machine is already linked), the code joins that link instead of making a new
 * one: the server checks the token belongs to the same account and hands out no new token
 * (ADR-027 re-link).
 */
async function pair(
  values: Record<string, string | boolean | undefined>,
  ask = true,
  existing?: ConnectorConfig,
): Promise<ConnectorConfig> {
  const server = existing === undefined ? serverFrom(values) : checkServerUrl(existing.server);
  // A re-link offers what this machine has now, or what it offered before when none is found.
  const agents =
    existing === undefined
      ? await gatherAgents(values, ask)
      : await gatherAgents(values, ask, existing.agents).catch(() => existing.agents);
  const name =
    existing !== undefined && values.name === undefined
      ? existing.name
      : ((values.name as string | undefined) ?? hostname()).trim().slice(0, 60) || 'My computer';
  if (values.shared === true) {
    print(
      'Shared agents keep their own memory and files on this computer; everyone who uses them may see what the agent remembers.',
    );
  }
  const res = await fetch(apiUrl(server, '/v1/connectors/claim'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(existing !== undefined && { authorization: `Bearer ${existing.token}` }),
    },
    body: JSON.stringify({
      code: values.code,
      name,
      agents: agents.map(publicAgent),
      // Self-hosted servers only: everyone on the server can call these agents (an admin's code).
      ...(values.shared === true && { shared: true }),
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(SETUP_HTTP_TIMEOUT_MS),
  }).catch(() => {
    throw new Error(
      `Could not reach ${server.origin}. Check the address and your internet connection.`,
    );
  });
  if (!res.ok) {
    const error = errorResponseSchema.safeParse(await res.json().catch(() => undefined));
    throw new ServerRefusal(
      error.success
        ? error.data.error.message
        : `The server refused the pairing (HTTP ${res.status}).`,
      error.success ? error.data.error.code : undefined,
    );
  }
  const body: unknown = await res.json();
  if (existing !== undefined) {
    relinkResponseSchema.parse(body);
    const config: ConnectorConfig = { ...existing, name, agents };
    await saveConfig(configPath(), config);
    return config;
  }
  const claim = claimResponseSchema.parse(body);
  const config: ConnectorConfig = {
    server: server.toString(),
    connector_id: claim.connector_id,
    token: claim.token,
    name,
    agents,
  };
  await saveConfig(configPath(), config);
  print(`Paired "${name}" with your Twring account.`);
  return config;
}

/** Links by showing a QR code the phone scans (ADR-025): the default when not paired yet. */
async function link(
  values: Record<string, string | boolean | undefined>,
): Promise<ConnectorConfig | undefined> {
  const server = serverFrom(values);
  const agents = await gatherAgents(values);
  const name = computerName((values.name as string | undefined) ?? hostname());
  const stop = new AbortController();
  // Ctrl+C, or the window closing: the request is withdrawn so the phone hears "expired".
  const onSigint = () => stop.abort();
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigint);
  process.once('SIGHUP', onSigint);
  let outcome;
  try {
    outcome = await linkComputer({
      server,
      computerName: name,
      agents: agents.map((a) => ({ local_agent: a.id, kind: a.kind, label: a.label })),
      print,
      signal: stop.signal,
    });
  } catch (error) {
    process.stderr.write(`${stop.signal.aborted ? 'Cancelled.' : (error as Error).message}\n`);
    return undefined;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigint);
    process.off('SIGHUP', onSigint);
  }
  // No `fail` (process.exit) straight after a fetch: see `exitWhenDrained`.
  if (outcome.kind !== 'approved') {
    process.stderr.write(
      outcome.kind === 'expired'
        ? `The code expired. Run ${CONNECTOR_CLI_NAME} again.\n`
        : 'Linking was cancelled on your phone.\n',
    );
    return undefined;
  }
  const config: ConnectorConfig = {
    server: server.toString(),
    connector_id: outcome.connectorId,
    token: outcome.token,
    name,
    agents,
  };
  await saveConfig(configPath(), config);
  linkedLines(name, outcome.ownerName).forEach(print);
  return config;
}

function run(config: ConnectorConfig): Promise<void> {
  const byId = new Map(config.agents.map((agent) => [agent.id, agent]));
  const labels = config.agents.map((a) => a.label).join(', ');
  // A pid file lets `setup` stop this copy; the status file tells it when the service connected.
  const dir = configDir();
  const report = (connected: boolean) =>
    void writeStatus(dir, {
      connected,
      agents: config.agents.map((a) => a.label),
      at: new Date().toISOString(),
      pid: process.pid,
    }).catch(() => undefined);
  void writePid(dir).catch(() => undefined);
  process.once('exit', () => clearPid(dir));
  const inService = process.env[SERVICE_ENV] === '1';
  // A service runs for months: keep its log (launchd, cron) from growing without end. On Windows
  // the launcher does it between runs (cmd.exe's `>>` does not append after a truncation).
  if (inService && process.platform !== 'win32') {
    const trim = () => void rotateLog(logPath(dir)).catch(() => undefined);
    trim();
    setInterval(trim, 60 * 60 * 1000).unref();
  }
  // Forgetting a revoked pairing is async: `main` exits right after `run`, so it waits for it.
  let forgetting: Promise<unknown> = Promise.resolve();
  const log = (line: string) => print(`  ${line}`);
  // This copy's Twring skill replaces an older one an agent already has (never adds one). Done
  // before the relay starts, so no agent starts while its skill folder is being swapped.
  const skillsRefreshed = refreshInstalledSkills(config.agents, process.env, homedir())
    .then((results) => skillLines(results, homedir()).forEach(log))
    .catch(() => undefined);
  const pool = new AgentPool({
    dir,
    createAdapter: (id, resumeRef, scope) => {
      const agent = byId.get(id);
      return agent === undefined ? undefined : createAdapter(agent, systemSpawn, resumeRef, scope);
    },
    log,
  });
  const client = new RelayClient({
    url: socketUrl(checkServerUrl(config.server)),
    server: checkServerUrl(config.server).toString(),
    token: config.token,
    agents: config.agents.map(publicAgent),
    version: VERSION,
    pool,
    onBackgroundResult: (agentId, text, sessionRef, turn) => {
      void deliverBackgroundResult(config, agentId, text, sessionRef, turn, {
        hasOpenChannel: (id, scope) => client.hasOpenChannel(id, scope),
        supports: (feature) => client.supports(feature),
        signal: client.stopSignal,
        print: log,
      });
    },
    log,
    onStatus: (status) => {
      switch (status.kind) {
        case 'connecting':
          if (status.attempt === 1) print(`Connecting to ${new URL(config.server).host}…`);
          return;
        case 'connected':
          report(true);
          print(`Connected as "${status.name}". Your phone can call: ${labels}.`);
          if (!inService) print('Keep this window open. Press Ctrl+C to disconnect.');
          return;
        case 'disconnected':
          report(false);
          print(`Connection lost. Trying again in ${Math.round(status.retryInMs / 1000)} s…`);
          return;
        case 'stopped':
          report(false);
          if (status.reason === 'replaced') {
            print(
              `${CONNECTOR_CLI_NAME} started on another window with this pairing; this one stopped.`,
            );
          } else {
            print('This computer is no longer paired with your Twring account.');
            print(`Link it again: npx ${CONNECTOR_CLI_NAME}`);
            forgetting = deleteConfigIfOwned(configPath(), config.connector_id).catch(() => false);
          }
          return;
      }
    },
  });
  process.once('SIGINT', () => {
    print('Disconnecting…');
    client.stop();
    pool.closeAll();
  });
  process.once('SIGTERM', () => {
    client.stop();
    pool.closeAll();
  });
  // The terminal window closed: agents run in their own process group (process.ts), so they would
  // not get the hang-up themselves. Stop them, and on any other exit too.
  process.once('SIGHUP', () => {
    client.stop();
    pool.closeAll();
  });
  process.once('exit', () => {
    client.stop();
    pool.closeAll();
  });
  // A stop during the refresh wins: starting a stopped client does nothing.
  void skillsRefreshed.then(() => client.start());
  return client.done
    .then(() => {
      pool.closeAll();
      return forgetting;
    })
    .then(() => undefined);
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      if (text.length < 1_000_000) text += chunk;
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(text));
  });
}

const HOOK_AGENT_KIND: Record<HookSource, string> = { claude: 'claude-code', codex: 'codex' };

/** A hook's ring or message. Its errors are the caller's to swallow: a hook must never fail. */
async function fromHook(
  mode: 'ring' | 'message',
  source: string,
  values: Record<string, string | boolean | undefined>,
  args: string[],
): Promise<void> {
  if (source !== 'claude' && source !== 'codex') {
    process.stderr.write('--from-hook takes claude or codex.\n');
    return;
  }
  // Codex passes the JSON as the last argument; Claude Code on stdin.
  const raw = args.length > 0 ? args[args.length - 1]! : await readStdin();
  const hook = parseHookInput(source, raw);
  if (hook === undefined) return;
  const config = await loadConfig(configPath());
  if (config === undefined) return;
  const agent =
    (values.agent as string | undefined) ??
    config.agents.find((a) => a.kind === HOOK_AGENT_KIND[source])?.id;
  const print = (line: string) => process.stderr.write(`${CONNECTOR_CLI_NAME}: ${line}\n`);
  if (mode === 'message') {
    await sendMessage(
      config,
      { text: hook.text, ...(agent !== undefined && { agent }) },
      { print },
    );
    return;
  }
  await ringOwner(
    config,
    {
      reason: hook.reason,
      ...(agent !== undefined && { agent }),
      ...(hook.sessionRef !== undefined && { session: hook.sessionRef }),
      wait: false,
    },
    { print },
  );
}

async function ringCommand(
  values: Record<string, string | boolean | undefined>,
  args: string[],
): Promise<number> {
  const hookSource = values['from-hook'] as string | undefined;
  if (hookSource !== undefined) {
    // A hook must never break the agent that ran it: every outcome exits 0, even a damaged
    // pairing file or a server that cannot be read.
    try {
      await fromHook('ring', hookSource, values, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong.';
      process.stderr.write(`${CONNECTOR_CLI_NAME}: ${message}\n`);
    }
    return 0;
  }
  const config = await loadConfig(configPath());
  if (config === undefined) {
    print(`Not linked yet. Link this computer first: npx ${CONNECTOR_CLI_NAME}`);
    return RING_EXIT.error;
  }
  const dir = configDir();
  if (values.cancel === true) {
    return cancelLastRing(config, {
      print,
      lastRing: () => readLastRing(dir),
      forget: () => forgetLastRing(dir),
    });
  }
  const reason = args.join(' ').trim();
  const stop = new AbortController();
  // Any way of stopping a waiting ring cancels it on the server (an agent's tool sends SIGTERM).
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => stop.abort());
  }
  return ringOwner(
    config,
    {
      reason,
      ...(typeof values.agent === 'string' && { agent: values.agent }),
      ...(typeof values.session === 'string' && { session: values.session }),
      wait: values.wait === true,
    },
    { print, signal: stop.signal, remember: (id) => saveLastRing(dir, id) },
  );
}

async function messageCommand(
  values: Record<string, string | boolean | undefined>,
  args: string[],
  filePaths: string[] = [],
  output: (line: string) => void = print,
): Promise<number> {
  const hookSource = values['from-hook'] as string | undefined;
  if (hookSource !== undefined) {
    try {
      await fromHook('message', hookSource, values, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong.';
      process.stderr.write(`${CONNECTOR_CLI_NAME}: ${message}\n`);
    }
    return 0;
  }
  const config = await loadConfig(configPath());
  if (config === undefined) {
    output(`Not linked yet. Link this computer first: npx ${CONNECTOR_CLI_NAME}`);
    return MESSAGE_EXIT.error;
  }
  const text = args.length > 0 ? args.join(' ') : await readStdin();
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  if (filePaths.length > 0) {
    if (filePaths.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      process.stderr.write('Send at most five files in one message.\n');
      return MESSAGE_EXIT.error;
    }
    const agent =
      typeof values.agent === 'string'
        ? config.agents.find((item) => item.id === values.agent)
        : config.agents[0];
    if (agent === undefined) {
      process.stderr.write('That agent is not linked on this computer.\n');
      return MESSAGE_EXIT.error;
    }
    if (text.trim().length > MAX_STORED_AGENT_MESSAGE_CHARS) {
      process.stderr.write(
        `The message is too long (maximum ${MAX_STORED_AGENT_MESSAGE_CHARS} characters).\n`,
      );
      return MESSAGE_EXIT.error;
    }
    try {
      const fileIds: string[] = [];
      const clientIds = filePaths.map(() => randomUUID());
      for (const [index, path] of filePaths.entries()) {
        fileIds.push(
          await uploadFile({
            server: config.server,
            token: config.token,
            localAgent: agent.id,
            sessionScope: envSessionScope(),
            path,
            name: basename(path),
            clientId: clientIds[index]!,
            signal: stop.signal,
          }),
        );
      }
      const server = checkServerUrl(config.server);
      const idempotencyKey = randomUUID();
      const body = JSON.stringify({
        local_agent: agent.id,
        text: text.trim(),
        origin: 'agent',
        file_ids: fileIds,
      });
      for (const delay of [0, 1_000, 5_000, 30_000]) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (stop.signal.aborted) throw new UploadError('cancelled', 'Message sending cancelled.');
        let response: Response | undefined;
        try {
          response = await fetch(apiUrl(server, '/v1/connectors/messages'), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${config.token}`,
              'content-type': 'application/json',
              'Idempotency-Key': idempotencyKey,
            },
            body,
            redirect: 'error',
            signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]),
          });
        } catch {
          if (stop.signal.aborted) throw new UploadError('cancelled', 'Message sending cancelled.');
        }
        if (response?.ok) {
          output('Sent to your Twring chat.');
          return MESSAGE_EXIT.sent;
        }
        if (response !== undefined && response.status !== 429 && response.status < 500) {
          const parsed = errorResponseSchema.safeParse(
            await response.json().catch(() => undefined),
          );
          throw new UploadError(
            parsed.success ? parsed.data.error.code : 'message_failed',
            'Could not send the message.',
          );
        }
      }
      throw new UploadError('message_failed', 'Could not send the message.');
    } catch (error) {
      process.stderr.write(
        `${error instanceof UploadError ? error.message : 'Could not send the files.'}\n`,
      );
      return MESSAGE_EXIT.error;
    }
  }
  return sendMessage(
    config,
    { text, ...(typeof values.agent === 'string' && { agent: values.agent }) },
    { print: output, signal: stop.signal },
  );
}

async function hooksCommand(
  values: Record<string, string | boolean | undefined>,
  args: string[],
): Promise<number> {
  const [action, source] = args;
  if (
    (action !== 'install' && action !== 'uninstall') ||
    (source !== 'claude' && source !== 'codex')
  ) {
    print(`Use: ${CONNECTOR_CLI_NAME} hooks install|uninstall claude|codex`);
    return 1;
  }
  const home = homedir();
  const lines =
    source === 'claude'
      ? action === 'install'
        ? await installClaudeHook(home, values.message === true ? 'message' : 'ring')
        : await uninstallClaudeHook(home)
      : action === 'install'
        ? await installCodexNotify(
            home,
            values['on-turn-complete'] === true,
            values.message === true ? 'message' : 'ring',
          )
        : await uninstallCodexNotify(home);
  lines.forEach(print);
  return 0;
}

const SCRIPT_NAME = `${CONNECTOR_CLI_NAME}.mjs`;

/** The line an agent relays to its owner when setup fails: always exactly one line. */
function setupFailure(error: unknown): string {
  if (error instanceof ServerRefusal && error.code === 'pairing_invalid') {
    return 'This code is wrong, used, or expired: ask for a new message in the Twring app.';
  }
  const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : '';
  return message !== '' ? message : 'Something went wrong.';
}

/**
 * `setup` (ADR-027): link with the phone's code if not linked yet, install the background service,
 * start it, and wait for it to connect. Safe to run again: it replaces what it installed before.
 */
async function setupCommand(values: Record<string, string | boolean | undefined>): Promise<number> {
  const say = (line: string) => print(line);
  try {
    let config = await loadConfig(configPath()).catch(() => undefined);
    if (config !== undefined && typeof values.server === 'string') {
      const conflict = serverConflict(config.server, serverFrom(values));
      if (conflict !== undefined) {
        say(conflict);
        return 2;
      }
    }
    // Already linked and the phone sent a code: claim it with this link, so the phone moves on.
    if (config !== undefined && typeof values.code === 'string') {
      try {
        config = await pair(values, false, config);
      } catch (error) {
        if (error instanceof ServerRefusal && error.code === 'pairing_other_account') {
          say(
            `This machine is linked to another Twring account. Run: node ${SCRIPT_NAME} uninstall --forget, then send the message again.`,
          );
          return 2;
        }
        throw error;
      }
    }
    if (config === undefined) {
      if (typeof values.code !== 'string') {
        say(
          `Not linked yet. Ask for the message in the Twring app (Add agent), then run: node ${SCRIPT_NAME} setup --code XXXX-XXXX`,
        );
        return 1;
      }
      config = await pair(values, false);
    }
    if (
      config !== undefined &&
      typeof values.code !== 'string' &&
      [values.acp, values['acp-agent'], values['openai-url'], values.command].some(
        (value) => typeof value === 'string',
      )
    ) {
      config.agents = await gatherAgents(values, false, config.agents);
      await saveConfig(configPath(), config);
    }
    const dir = configDir();
    const host = systemHost();
    // Nothing else may hold this pairing: the old service and any copy started by hand.
    stopService(host);
    await stopRunning(dir);
    // Only a status the new service writes counts.
    await clearStatus(dir);
    await prepareLog(logPath(dir));
    const spec = serviceSpecFor({
      node: process.execPath,
      script: await installScript(process.argv[1] ?? SCRIPT_NAME, dir),
      cwd: process.cwd(),
      env: process.env,
      configDir: dir,
    });
    const since = Date.now();
    const installed = await installService(spec, host, dir);
    const status = await waitConnected(dir, since);
    installed.notes.forEach(say);
    if (status === undefined) {
      say(
        `Twring is installed but did not connect within 20 seconds. Check this machine's internet connection. Details: ${installed.kind === 'systemd-system' || installed.kind === 'systemd-user' ? `journalctl ${installed.kind === 'systemd-user' ? '--user ' : ''}-u cord-connect` : logPath(dir)}`,
      );
      return 1;
    }
    if (values['no-skill'] !== true) {
      const home = homedir();
      const results = [];
      for (const target of skillTargets(config.agents, process.env, home)) {
        results.push(await installSkill(target));
      }
      skillLines(results, home).forEach(say);
    }
    const agents = status.agents.length > 0 ? status.agents : config.agents.map((a) => a.label);
    say(
      `Twring is ready. Your phone can call: ${agents.join(', ')}. It keeps running in the background.`,
    );
    say(
      JSON.stringify({ command: 'node', args: [resolve(process.argv[1] ?? SCRIPT_NAME), 'mcp'] }),
    );
    return 0;
  } catch (error) {
    say(setupFailure(error));
    return 1;
  }
}

async function uninstallCommand(
  values: Record<string, string | boolean | undefined>,
): Promise<number> {
  const dir = configDir();
  await uninstallService(systemHost(), dir);
  await stopRunning(dir);
  const left = await removeRunFiles(dir);
  if (values.forget === true) {
    await deleteConfig(configPath());
    print('Twring stopped and was removed from this machine, and its link was forgotten.');
  } else {
    print('Twring stopped and will no longer start by itself. The link is kept.');
  }
  if (left.length > 0) print(`Still in use, so left behind (delete later): ${left.join(', ')}`);
  return 0;
}

async function main(): Promise<void> {
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        agent: { type: 'string' },
        file: { type: 'string', multiple: true },
        session: { type: 'string' },
        wait: { type: 'boolean' },
        cancel: { type: 'boolean' },
        message: { type: 'boolean' },
        'from-hook': { type: 'string' },
        'on-turn-complete': { type: 'boolean' },
        code: { type: 'string' },
        server: { type: 'string' },
        name: { type: 'string' },
        agents: { type: 'string' },
        command: { type: 'string' },
        'command-label': { type: 'string' },
        acp: { type: 'string' },
        'acp-label': { type: 'string' },
        'acp-agent': { type: 'string' },
        'openai-url': { type: 'string' },
        'openai-model': { type: 'string' },
        'openai-key-env': { type: 'string' },
        'openai-label': { type: 'string' },
        registry: { type: 'boolean' },
        cwd: { type: 'string' },
        'claude-allow-edits': { type: 'boolean' },
        'acp-allow': { type: 'string' },
        'codex-sandbox': { type: 'string' },
        'no-skill': { type: 'boolean' },
        forget: { type: 'boolean' },
        shared: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    }));
  } catch (error) {
    fail(`${(error as Error).message}\n\n${HELP}`);
  }
  if (values.help === true) return void print(HELP);
  if (values.version === true) return void print(VERSION);
  const [command, ...rest] = positionals;
  const { file: filePaths, ...commandValues } = values;
  if (command === 'agents') {
    if (values.registry === true) {
      const registry = await fetchRegistry();
      registry.agents.forEach((agent) =>
        print(`${agent.id}\t${agent.name}\t${agent.description.slice(0, 120)}`),
      );
    } else {
      const config = await loadConfig(configPath());
      (config?.agents ?? []).forEach((agent) =>
        print(`${agent.id}\t${agent.label}\t${agent.kind}`),
      );
    }
    return;
  }
  if (command === 'doctor') {
    const config = await loadConfig(configPath());
    const agents =
      config?.agents.filter((agent) => values.agent === undefined || agent.id === values.agent) ??
      [];
    if (agents.length === 0) {
      process.stderr.write('No matching configured agents.\n');
      return exitWhenDrained(1);
    }
    return exitWhenDrained(await doctor(agents, print));
  }
  if (command === 'mcp') {
    const linked = async () => {
      const config = await loadConfig(configPath());
      if (!config)
        throw new Error("This computer isn't linked to Twring. Run npx twring-connect first.");
      return config;
    };
    return serveMcp(
      process.stdin,
      process.stdout,
      {
        ring: async (reason, wait) => {
          const code = await ringOwner(
            await linked(),
            { reason, wait },
            { print: () => undefined },
          );
          const outcome = (
            {
              0: wait ? 'answered' : 'ringing',
              2: 'refused',
              3: 'declined',
              4: 'missed',
              5: 'cancelled',
            } as Record<number, string>
          )[code];
          if (outcome === undefined)
            throw new Error('Could not ring your phone. Check the Twring connection.');
          return outcome;
        },
        message: async (message, files) => {
          await linked();
          const result = await messageCommand({}, [message], files, () => undefined);
          if (result !== 0) throw new Error('Could not send the message.');
          return 'Sent to your Twring chat.';
        },
        status: async () => {
          const config = await loadConfig(configPath());
          if (!config) return 'This computer is not linked to Twring.';
          const status = await readStatus(configDir());
          return `Linked; ${status?.connected ? 'online' : 'offline'}; agents: ${config.agents.map((agent) => agent.label).join(', ')}.`;
        },
        words: async (words) => {
          const lines: string[] = [];
          const code = await addWords(
            await linked(),
            {
              words,
              ...(typeof commandValues.agent === 'string' && { agent: commandValues.agent }),
            },
            { print: (line) => lines.push(line) },
          );
          if (code !== WORDS_EXIT.added)
            throw new Error(lines.join(' ') || 'Could not add the words.');
          return lines.join(' ');
        },
      },
      VERSION,
    );
  }
  if (command === 'words') {
    const config = await loadConfig(configPath());
    if (config === undefined) {
      print(`Not linked yet. Link this computer first: npx ${CONNECTOR_CLI_NAME}`);
      return exitWhenDrained(WORDS_EXIT.error);
    }
    return exitWhenDrained(
      await addWords(
        config,
        {
          words: rest,
          ...(typeof commandValues.agent === 'string' && { agent: commandValues.agent }),
        },
        { print },
      ),
    );
  }
  if (command === 'ring') return exitWhenDrained(await ringCommand(commandValues, rest));
  if (command === 'message')
    return exitWhenDrained(await messageCommand(commandValues, rest, filePaths));
  if (command === 'hooks') return exitWhenDrained(await hooksCommand(commandValues, rest));
  if (command === 'setup') return exitWhenDrained(await setupCommand(commandValues));
  if (command === 'uninstall') return exitWhenDrained(await uninstallCommand(commandValues));
  if (command !== undefined) fail(`Unknown command "${command}".\n\n${HELP}`);
  if (values.forget === true) {
    await deleteConfig(configPath());
    return void print(
      "Removed this computer's pairing. Remove it in the app too, under your computers.",
    );
  }
  const inService = process.env[SERVICE_ENV] === '1';
  // Not paired yet and no code: show a QR code for the phone to scan (ADR-025).
  let saved: ConnectorConfig | undefined;
  try {
    saved = values.code !== undefined ? undefined : await loadConfig(configPath());
  } catch (error) {
    if (!inService) throw error;
    // A damaged pairing as a service: starting again cannot fix it, so say so once and stop.
    process.stderr.write(`${(error as Error).message.replace(/\s+/g, ' ').trim()}\n`);
    return exitWhenDrained(NOT_PAIRED_EXIT);
  }
  if (saved !== undefined && typeof values.server === 'string') {
    const conflict = serverConflict(saved.server, serverFrom(commandValues));
    if (conflict !== undefined) {
      process.stderr.write(`${conflict}
`);
      return exitWhenDrained(2);
    }
  }
  if (
    saved !== undefined &&
    [values.acp, values['acp-agent'], values['openai-url'], values.command].some(
      (value) => typeof value === 'string',
    )
  ) {
    saved.agents = await gatherAgents(commandValues, false, saved.agents);
    await saveConfig(configPath(), saved);
  }
  // As a background service there is no one to scan a code: say what to do and stop, with the
  // exit code that tells the service manager not to start it again (NOT_PAIRED_EXIT).
  if (saved === undefined && values.code === undefined && inService) {
    process.stderr.write(
      `Not linked yet. Link again: node ${SCRIPT_NAME} setup --code XXXX-XXXX
`,
    );
    return exitWhenDrained(NOT_PAIRED_EXIT);
  }
  const config =
    values.code !== undefined ? await pair(commandValues) : (saved ?? (await link(commandValues)));
  if (config === undefined) return exitWhenDrained(1);
  await run(config);
  process.exit(0);
}

/**
 * Ends a one-shot command without `process.exit` straight after a fetch: on Windows that can abort
 * Node while a socket is still closing (libuv `UV_HANDLE_CLOSING` assertion), turning an answered
 * ring into a crash and a wrong exit code. Exit naturally; a backstop covers a lingering handle.
 */
function exitWhenDrained(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
}

main().catch((error: unknown) =>
  fail(error instanceof Error ? error.message : 'Something went wrong.'),
);
