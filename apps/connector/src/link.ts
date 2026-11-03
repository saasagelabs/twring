import {
  CONNECTOR_CLI_NAME,
  createLinkResponseSchema,
  errorResponseSchema,
  LINK_INVISIBLE,
  linkPollResponseSchema,
  linkQrPayload,
  type LinkAgent,
} from '@twring/contracts';
import { renderUnicodeCompact } from 'uqr';

import { apiUrl } from './config';

/**
 * Computer-first linking (ADR-025): this computer asks the server for a short code, shows it as a
 * QR code, and waits while the owner scans it with the Twring app and approves.
 */

export type LinkOutcome =
  | { kind: 'approved'; connectorId: string; token: string; ownerName?: string }
  | { kind: 'expired' }
  | { kind: 'rejected' };

export interface LinkOptions {
  server: URL;
  computerName: string;
  agents: LinkAgent[];
  print: (line: string) => void;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Seconds each long poll waits on the server. */
  waitS?: number;
  /** Pause after a failed poll before trying again. */
  retryMs?: number;
  /** Extra time a poll may take beyond its wait before it counts as failed. */
  pollSlackMs?: number;
  renderQr?: (text: string) => string;
  /** How long withdrawing the request may take once cancelled (best effort). */
  cancelTimeoutMs?: number;
}

/** What the CLI prints once linked: whose account this computer joined (anti-hijack). */
export function linkedLines(computer: string, ownerName: string | undefined): string[] {
  if (ownerName === undefined) return [`Linked "${computer}" with your Twring account.`];
  return [
    `Linked to ${ownerName}'s Twring account. If that isn't you, press Ctrl+C and run ${CONNECTOR_CLI_NAME} --forget.`,
  ];
}

/**
 * A `--server` that differs from the saved pairing's: the message to show, or undefined when they
 * match. The saved pairing is never silently used for a server the user did not mean.
 */
export function serverConflict(saved: string, given: URL): string | undefined {
  const norm = (url: string) => url.replace(/\/+$/, '');
  if (norm(new URL(saved).toString()) === norm(given.toString())) return undefined;
  return `Already linked to ${norm(saved)}. Run ${CONNECTOR_CLI_NAME} --forget first to link to a different server.`;
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

const INVISIBLE = new RegExp(LINK_INVISIBLE.source, 'g');
const CUT_SURROGATE = /[\ud800-\udbff]$/;

/** A host name fit for the app: ordinary characters, at most 40, never empty. */
export function computerName(input: string): string {
  const clean = input.replace(UNSAFE, '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  // At most 40 UTF-16 units (the server's limit), never half of an emoji.
  const cut = clean.slice(0, 40).replace(CUT_SURROGATE, '').trim();
  return cut === '' ? 'My computer' : cut;
}

/** The QR code for the terminal, or undefined when it cannot be drawn (the code still works). */
export function terminalQr(
  text: string,
  render: (text: string) => string = (t) => renderUnicodeCompact(t, { border: 2 }),
): string | undefined {
  try {
    return render(text);
  } catch {
    return undefined;
  }
}

/** `ABCD-EFGH` spaced out so it reads easily from across a desk. */
export function bigCode(code: string): string {
  return code.split('').join(' ');
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    // Removes its abort listener either way, so retries never pile listeners on the signal.
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/** Slack on top of the long poll's own wait before a silent connection counts as failed. */
const POLL_SLACK_MS = 10_000;

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const error = errorResponseSchema.safeParse(await res.json().catch(() => undefined));
  return error.success ? error.data.error.message : fallback;
}

export async function linkComputer(options: LinkOptions): Promise<LinkOutcome> {
  const doFetch = options.fetch ?? fetch;
  const { server, print, signal } = options;
  const res = await doFetch(apiUrl(server, '/v1/connectors/link-requests'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ computer_name: options.computerName, agents: options.agents }),
    redirect: 'error',
    ...(signal !== undefined && { signal }),
  }).catch(() => {
    throw new Error(`Could not reach ${server.host}. Check your internet connection.`);
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `The server refused (HTTP ${res.status}).`));
  }
  const link = createLinkResponseSchema.parse(await res.json());
  // When the code stops working, by this computer's clock (the two clocks may differ). Past it, a
  // server that cannot be reached could only say "expired": stop instead of retrying forever.
  const deadline = Date.now() + (Date.parse(link.expires_at) - Date.parse(link.server_time));

  const qr = terminalQr(linkQrPayload(link.code, server.toString()), options.renderQr);
  print('');
  print('Open Twring on your phone → Add agent → On my computer → Scan');
  print('');
  if (qr !== undefined) {
    print(qr);
    print('');
  }
  print(`Or type this code:   ${bigCode(link.code)}`);
  print('');
  print('Waiting for your phone… (the code works for 10 minutes)');

  const pollUrl = apiUrl(
    server,
    `/v1/connectors/link-requests/${link.request_id}?wait=${options.waitS ?? 25}`,
  );
  const waitMs = (options.waitS ?? 25) * 1000;
  /** Withdraws the request so the phone hears "expired"; best effort, within a short deadline. */
  const cancelled = async (): Promise<never> => {
    await doFetch(apiUrl(server, `/v1/connectors/link-requests/${link.request_id}`), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${link.poll_token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(options.cancelTimeoutMs ?? 3_000),
    }).catch(() => undefined);
    throw new Error('Cancelled.');
  };
  /** Pauses before the next try; false once the code has expired. */
  const retry = async (): Promise<boolean> => {
    if (Date.now() >= deadline) return false;
    await sleep(options.retryMs ?? 3_000, signal);
    return true;
  };
  for (;;) {
    if (signal?.aborted) return cancelled();
    let answer: unknown;
    try {
      // A connection that goes quiet (no reset) must not hold a poll for minutes.
      const timeout = AbortSignal.timeout(waitMs + (options.pollSlackMs ?? POLL_SLACK_MS));
      const poll = await doFetch(pollUrl, {
        headers: { authorization: `Bearer ${link.poll_token}` },
        redirect: 'error',
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      // The server forgot the request (a restart, or a newer one replaced it): run again.
      if (poll.status === 404) return { kind: 'expired' };
      if (!poll.ok) throw new Error(`HTTP ${poll.status}`);
      answer = await poll.json();
    } catch {
      if (signal?.aborted) return cancelled();
      if (await retry()) continue;
      return { kind: 'expired' };
    }
    const parsed = linkPollResponseSchema.safeParse(answer);
    if (!parsed.success) {
      if (await retry()) continue;
      return { kind: 'expired' };
    }
    switch (parsed.data.status) {
      case 'pending':
        continue;
      case 'approved':
        return {
          kind: 'approved',
          connectorId: parsed.data.connector_id,
          token: parsed.data.connector_token,
          ...(parsed.data.owner_name !== undefined && { ownerName: parsed.data.owner_name }),
        };
      case 'expired':
        return { kind: 'expired' };
      case 'rejected':
        return { kind: 'rejected' };
    }
  }
}
