import { CONNECTOR_CLI_NAME, STAY_ON_CALL_RULE, TEXT_TURN_TAG } from '@twring/contracts';

/**
 * The one-time call preamble (hang-up marker, ADR-024; ringing the owner). Claude Code gets it as
 * its voice system prompt; ACP agents and Codex take no system prompt here, so it goes in front of
 * the first user turn of each session.
 */

/** How this connector process was started, enough to start it again from a shell. */
export interface Launch {
  execPath: string;
  /** The script node ran (`process.argv[1]`); undefined when unknown. */
  script: string | undefined;
  /** Node flags it ran with (`process.execArgv`): tsx's loader, when run from TypeScript. */
  execArgv: readonly string[];
  platform: NodeJS.Platform;
}

export function currentLaunch(): Launch {
  return {
    execPath: process.execPath,
    script: process.argv[1],
    execArgv: process.execArgv,
    platform: process.platform,
  };
}

/** Plain words a POSIX shell takes as they are. */
const SAFE_WORD = /^[A-Za-z0-9_\-./:=@%+,]+$/;
/** Plain words PowerShell takes as they are (a comma would make an array, `@` a splat). */
const SAFE_PS_WORD = /^[A-Za-z0-9_\-./:\\]+$/;

/** One argument for a POSIX shell: single quotes, with `'` written as `'\''`. */
export function posixQuote(arg: string): string {
  if (SAFE_WORD.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * One argument for PowerShell: single quotes (literal). PowerShell reads any of `'‘’‚‛` as a
 * single quote, and a doubled quote as its second character, so each one is escaped by a `'` in
 * front of it (`O’Neil` → `'O'’Neil'`), which keeps the character itself.
 */
export function powershellQuote(arg: string): string {
  if (SAFE_PS_WORD.test(arg)) return arg;
  return `'${arg.replace(/['‘’‚‛]/g, "'$&")}'`;
}

/** Node flags that make a TypeScript entry point runnable again (tsx registers its loader so). */
function loaderFlags(execArgv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i += 1) {
    const flag = execArgv[i]!;
    if (/^--(import|require|loader|experimental-loader)$/.test(flag) && i + 1 < execArgv.length) {
      out.push(flag, execArgv[i + 1]!);
      i += 1;
    } else if (/^--(import|require|loader|experimental-loader)=/.test(flag)) {
      out.push(flag);
    }
  }
  return out;
}

/**
 * The command that rings the owner from this computer, e.g. `node /home/me/cord-connect.mjs ring`:
 * this very node and script, quoted for a POSIX shell or (on Windows) PowerShell. Unknown script:
 * `npx cord-connect ring`.
 */
export function ringCommand(launch: Launch = currentLaunch()): string {
  if (launch.script === undefined || launch.script === '') return `npx ${CONNECTOR_CLI_NAME} ring`;
  const typescript = /\.[cm]?ts$/i.test(launch.script);
  const argv = [
    launch.execPath,
    ...(typescript ? loaderFlags(launch.execArgv) : []),
    launch.script,
    'ring',
  ];
  if (launch.platform === 'win32') {
    const quoted = argv.map(powershellQuote);
    // A quoted first word is a string to PowerShell, not a command: `&` runs it.
    return quoted[0]!.startsWith("'") ? `& ${quoted.join(' ')}` : quoted.join(' ');
  }
  return argv.map(posixQuote).join(' ');
}

/**
 * Where someone other than the owner (a shared server agent) has the agent keep the requests
 * they make on a call: their own file, never the owner's `twring-requests.md`.
 */
export function requestsFile(scope: string): string {
  return `twring-requests-${scope.slice(0, 8)}.md`;
}

/**
 * What the agent is told when the person on the line is a member of the owner's team (a shared
 * server agent): who they are, that its ring, message and words commands reach them, and where
 * their requests go.
 */
export function memberInstructions(ring: string, scope: string): string {
  return (
    "You are connected through Twring to a member of your owner's team, not your owner, by live voice calls and by typed messages. " +
    'Do not share what your owner or other people told you in their own conversations. ' +
    `On a call everything you write is spoken aloud: answer in short, plain spoken sentences, no markdown. ${STAY_ON_CALL_RULE} ` +
    `A turn that starts with ${TEXT_TURN_TAG} was typed in the Twring chat: answer in normal written text; markdown, lists and code are fine there, and the call rules do not apply. ` +
    `To ring this person later (for example when a long task finishes), run: ${ring} "<short reason>". ` +
    'Your Twring ring, message and words commands reach this person, not your owner. ' +
    `Write down requests this person makes on a call in ${requestsFile(scope)}, not in twring-requests.md. ` +
    'If the call ends while you are still working on something they asked for, keep going and finish it; your final reply is saved in your Twring chat with them.'
  );
}

/** What every agent is told about the call, in plain sentences. */
export function callInstructions(ring: string, scope?: string): string {
  if (scope !== undefined) return memberInstructions(ring, scope);
  return (
    'You are connected to your owner through Twring, by live voice calls and by typed messages. ' +
    `On a call everything you write is spoken aloud: answer in short, plain spoken sentences, no markdown. ${STAY_ON_CALL_RULE} ` +
    `A turn that starts with ${TEXT_TURN_TAG} was typed in the Twring chat: answer in normal written text; markdown, lists and code are fine there, and the call rules do not apply. ` +
    'To ring your owner later (for example when a ' +
    `long task finishes), run: ${ring} "<short reason>". ` +
    'If the call ends while you are still working on something the owner asked for, keep going and finish it; your final reply is saved in your Twring chat with them, and they may get a call or a notification.'
  );
}

/** The preamble put in front of an ACP or Codex session's first user turn. */
export function callPreamble(ring: string = ringCommand(), scope?: string): string {
  return `[${callInstructions(ring, scope)}]`;
}

/** `text` with the preamble in front. */
export function withPreamble(preamble: string, text: string): string {
  return `${preamble}\n\n${text}`;
}
