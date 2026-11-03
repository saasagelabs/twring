import {
  CONNECTOR_CLI_NAME,
  normalizePairingCode,
  parseConnectorEndpoint,
  type Agent,
  type Connector,
  type LinkApproveResponse,
} from '@twring/contracts';

/**
 * "Send a message to my agent" (ADR-027): the owner forwards one message to the agent they already
 * chat with, and the agent sets itself up. Every technical word lives inside the message, for the
 * agent; the screen around it stays plain.
 */

export const AGENT_MESSAGE_COPY = {
  title: 'Send a message to your agent',
  body: 'Your agent sets itself up. Send it this message in the chat you already use with it (Telegram, WhatsApp, or any other).',
  waiting: 'Waiting for your agent…',
  expired: 'This message expired. Make a new one and send that instead.',
  newMessage: 'Make a new message',
  share: 'Share',
  copy: 'Copy',
  copied: 'Copied',
  scan: 'Scan a code on my computer',
  otherWays: 'Other ways',
} as const;

/**
 * Characters a URL may keep in the command unquoted: none of them means anything to a POSIX shell,
 * PowerShell, or cmd.exe. `new URL` already percent-encodes spaces, quotes, and backticks.
 */
const SHELL_SAFE_URL = /^[A-Za-z0-9\-._~:/%]+$/;

/**
 * The API base URL as `https://host[:port][/path]` (no trailing slash, query, or fragment), or
 * undefined when it is not an http(s) URL or a shell could read part of it as syntax.
 */
export function serverBase(server: string): string | undefined {
  let url: URL;
  try {
    url = new URL(server.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return SHELL_SAFE_URL.test(base) ? base : undefined;
}

/**
 * Where agents download the connector: `<downloads>/downloads/twring-connect.mjs`. `downloads` is
 * Twring's own address (a self-hosted server serves no downloads); it defaults to `server`.
 */
export function connectorDownloadUrl(
  server: string,
  downloads: string = server,
): string | undefined {
  const base = serverBase(downloads);
  return base === undefined ? undefined : `${base}/downloads/${CONNECTOR_CLI_NAME}.mjs`;
}

/**
 * The one-line command inside the message, or undefined when the server or code cannot make a
 * working one. It names the server: the downloaded file's own default is Twring's staging server,
 * and the code only exists on the server that made it.
 */
export function agentSetupCommand(
  code: string,
  server: string,
  downloads: string = server,
): string | undefined {
  const file = `${CONNECTOR_CLI_NAME}.mjs`;
  const base = serverBase(server);
  const download = connectorDownloadUrl(server, downloads);
  const formatted = normalizePairingCode(code);
  if (base === undefined || download === undefined || formatted === undefined) return undefined;
  return `curl -fsSL ${download} -o ${file} && node ${file} setup --code ${formatted} --server ${base}`;
}

/** The whole message the owner forwards to their agent, or undefined when no command can be made. */
export function agentSetupMessage(
  code: string,
  server: string,
  downloads: string = server,
): string | undefined {
  const command = agentSetupCommand(code, server, downloads);
  const base = serverBase(downloads);
  if (command === undefined || base === undefined) return undefined;
  return [
    'Please connect yourself to my Twring app so I can talk to you by voice. On the machine you run on, run this, then tell me the last line it prints:',
    '',
    command,
    '',
    // Windows PowerShell 5 has `curl` as a name for Invoke-WebRequest, and no `&&`.
    "It needs Node.js 20 or newer; install it first if it's missing. On Windows PowerShell, use curl.exe instead of curl and run the two parts one after the other. The code works for 10 minutes.",
    '',
    // The skill is how an agent learns to behave on calls; setup installs it only for the agents
    // it knows (twring-connect skillTargets).
    `Then read the Twring skill: how to talk on my calls, and to write down anything I ask for on a call so it gets done. Setup adds it for Claude Code, Codex and Hermes; any other agent can download it, unpack it into its skills folder and read SKILL.md: ${base}/downloads/twring-skill.tar.gz`,
  ].join('\n');
}

/** A claimed computer in the shape the agent picker ("Choose your agents") takes. */
/**
 * The local agents of a computer already saved on this phone: a re-linked computer (ADR-027) shows
 * them on the picker as already added, so none is added twice.
 */
export function alreadyAddedFor(agents: readonly Agent[], connectorId: string): string[] {
  const out: string[] = [];
  for (const agent of agents) {
    if (agent.protocol !== 'cord-connector') continue;
    const endpoint = parseConnectorEndpoint(agent.endpoint_url);
    if (endpoint?.connectorId === connectorId && !out.includes(endpoint.localAgent)) {
      out.push(endpoint.localAgent);
    }
  }
  return out;
}

export function linkedFromConnector(connector: Connector): LinkApproveResponse {
  return {
    connector_id: connector.id,
    computer_name: connector.name.slice(0, 40),
    agents: connector.agents.map((agent) => ({
      local_agent: agent.id,
      kind: agent.kind,
      label: agent.label,
    })),
  };
}
