import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_STORED_AGENT_MESSAGE_CHARS } from '@twring/contracts';
import { WebSocketServer } from 'ws';

import { AcpAdapter } from './adapters/acp';
import { buildClaudeArgs, ClaudeCodeAdapter, READ_ONLY_TOOLS } from './adapters/claude-code';
import { CodexAdapter } from './adapters/codex';
import { createAdapter } from './agents';
import type { ConnectorConfig } from './config';
import type { LocalAgentAdapter, LocalAgentEvent } from './events';
import { fakeSpawner } from './fake-child';
import {
  claudeSettingsPath,
  codexConfigPath,
  hookCommand,
  installClaudeHook,
  installCodexNotify,
  parseHookInput,
  uninstallClaudeHook,
  uninstallCodexNotify,
} from './hooks';
import { RelayClient } from './relay';
import { AgentPool } from './pool';
import {
  firstSentence,
  deliverBackgroundResult,
  RING_EXIT,
  MESSAGE_EXIT,
  cancelLastRing,
  ringOwner,
  sendMessage,
  type FetchFn,
  type RingOptions,
} from './ring';

describe('first sentence for a background ring', () => {
  it('strips markers and collapses whitespace', () => {
    expect(firstSentence('  Done ⟪hangup⟫  now.  More detail.')).toBe('Done now.');
  });
  it('keeps the whole reply without punctuation', () => {
    expect(firstSentence('  Still working\n on the task  ')).toBe('Still working on the task');
  });
  it('ends at the first sentence punctuation followed by space or end', () => {
    expect(firstSentence('Build passed! Files are ready.')).toBe('Build passed!');
    expect(firstSentence('  Done?\nYes.')).toBe('Done?');
  });
});

describe('detached result rings', () => {
  it('skips a ring during an open call, otherwise uses the first sentence and session', async () => {
    const calls: RingOptions[] = [];
    const lines: string[] = [];
    const ring = (_config: ConnectorConfig, options: RingOptions) => {
      calls.push(options);
      return Promise.resolve(RING_EXIT.answered);
    };
    await deliverBackgroundResult(
      config(),
      'codex',
      'Done. More detail.',
      'thread_7',
      { turnId: 't1', surface: 'call' },
      {
        hasOpenChannel: () => true,
        supports: () => false,
        print: (line) => lines.push(line),
        ring,
      },
    );
    expect(calls).toEqual([]);
    await deliverBackgroundResult(
      config(),
      'codex',
      'Done ⟪hangup⟫. More detail.',
      'thread_7',
      { turnId: 't1', surface: 'call' },
      {
        hasOpenChannel: () => false,
        supports: () => false,
        print: (line) => lines.push(line),
        ring,
      },
    );
    expect(calls).toEqual([{ reason: 'Done.', agent: 'codex', session: 'thread_7', wait: false }]);
    expect(lines).toEqual([
      'background result not delivered: channel open',
      'background result delivered (ring)',
    ]);
  });

  it('logs a ring failure without throwing', async () => {
    const lines: string[] = [];
    await deliverBackgroundResult(
      config(),
      'codex',
      'Done.',
      'bad ref!',
      { turnId: 't1', surface: 'call' },
      {
        hasOpenChannel: () => false,
        supports: () => false,
        print: (line) => lines.push(line),
        ring: (_config, options) => {
          expect(options.session).toBeUndefined();
          return Promise.reject(new Error('offline'));
        },
      },
    );
    expect(lines).toEqual(['background result not delivered: ring failed']);
  });
});

describe('detached result delivery', () => {
  const turn = { turnId: 'turn-7', surface: 'call' as const };
  const success = () =>
    new Response(JSON.stringify({ message_id: `msg_${'a'.repeat(20)}`, delivery: 'push' }), {
      status: 201,
    });
  const run = (overrides: Partial<Parameters<typeof deliverBackgroundResult>[5]> = {}) => {
    const lines: string[] = [];
    const requests: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn<FetchFn>((url, init) => {
      requests.push({ url, init });
      return Promise.resolve(success());
    });
    const ring = vi.fn(() => Promise.resolve(RING_EXIT.answered));
    const deps = {
      hasOpenChannel: () => false,
      supports: () => true,
      print: (line: string) => lines.push(line),
      fetch,
      ring,
      ...overrides,
    };
    return { lines, requests, fetch, ring, deps };
  };

  it("posts a person's result with their session scope and never rings the owner", async () => {
    const scope = 'b'.repeat(32);
    const open: [string, string | undefined][] = [];
    const t = run({
      hasOpenChannel: (agent: string, s?: string) => {
        open.push([agent, s]);
        return false;
      },
    });
    await deliverBackgroundResult(
      config(),
      'codex',
      'Done.',
      'thread_7',
      { ...turn, scope },
      t.deps,
    );
    expect(open).toEqual([['codex', scope]]);
    expect(JSON.parse(t.requests[0]?.init.body as string)).toMatchObject({ session_scope: scope });
    // No message delivery: a scoped result is dropped, never rung to the computer's owner.
    const old = run({ supports: () => false });
    await deliverBackgroundResult(
      config(),
      'codex',
      'Done.',
      'thread_7',
      { ...turn, scope },
      old.deps,
    );
    expect(old.ring).not.toHaveBeenCalled();
    expect(old.lines).toEqual(['background result not delivered: messages unavailable']);
  });

  it('posts full text, origin, session and idempotency key once', async () => {
    const t = run();
    await deliverBackgroundResult(
      config(),
      'codex',
      'Full answer. More detail.',
      'thread_7',
      turn,
      t.deps,
    );
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]?.url).toBe('https://cord.example.com/v1/connectors/messages');
    expect(JSON.parse(t.requests[0]?.init.body as string)).toEqual({
      local_agent: 'codex',
      text: 'Full answer. More detail.',
      origin: 'call_turn',
      turn_id: 'turn-7',
      session_ref: 'thread_7',
    });
    expect(t.requests[0]?.init.headers).toMatchObject({
      'Idempotency-Key': 'turn-7',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(t.lines).toEqual(['background result delivered (push)']);
    expect(t.ring).not.toHaveBeenCalled();
  });

  it('retries 503 and network errors with the same key', async () => {
    vi.useFakeTimers();
    try {
      const t = run();
      t.fetch
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(new Response('', { status: 503 }));
      const pending = deliverBackgroundResult(config(), 'codex', 'Done.', undefined, turn, t.deps);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
      expect(t.fetch).toHaveBeenCalledTimes(3);
      expect(
        t.fetch.mock.calls.map(
          ([, init]) => (init.headers as Record<string, string>)['Idempotency-Key'],
        ),
      ).toEqual(['turn-7', 'turn-7', 'turn-7']);
      expect(t.lines).toEqual(['background result delivered (push)']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back on 404 by surface; other 4xx stops', async () => {
    const t = run();
    t.fetch.mockResolvedValue(new Response('', { status: 404 }));
    await deliverBackgroundResult(config(), 'codex', 'Done.', undefined, turn, t.deps);
    await deliverBackgroundResult(
      config(),
      'codex',
      'Done.',
      undefined,
      { ...turn, surface: 'text' },
      t.deps,
    );
    expect(t.ring).toHaveBeenCalledTimes(1);
    expect(JSON.parse(t.fetch.mock.calls[1]?.[1].body as string)).toMatchObject({
      origin: 'text_turn',
    });
    t.fetch.mockResolvedValue(new Response('', { status: 400 }));
    await deliverBackgroundResult(config(), 'codex', 'Done.', undefined, turn, t.deps);
    expect(t.ring).toHaveBeenCalledTimes(1);
    expect(t.lines.at(-1)).toBe('background result not delivered: HTTP 400');
  });

  it('ignores text on old gateways and skips open channels', async () => {
    const t = run({ supports: () => false });
    await deliverBackgroundResult(
      config(),
      'codex',
      'Done.',
      undefined,
      { ...turn, surface: 'text' },
      t.deps,
    );
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.ring).not.toHaveBeenCalled();
    await deliverBackgroundResult(config(), 'codex', 'Done.', undefined, turn, {
      ...t.deps,
      hasOpenChannel: () => true,
    });
    expect(t.ring).not.toHaveBeenCalled();
  });

  it('stop cancels a pending retry', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const t = run({ signal: controller.signal });
      t.fetch.mockResolvedValueOnce(new Response('', { status: 503 }));
      const pending = deliverBackgroundResult(config(), 'codex', 'Done.', undefined, turn, t.deps);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await pending;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(t.fetch).toHaveBeenCalledTimes(1);
      expect(t.lines).toEqual(['background result not delivered: connector stopped']);
    } finally {
      vi.useRealTimers();
    }
  });
});

const TOKEN = `cct_${'a'.repeat(43)}`;
const INVITE = `inv_${'a'.repeat(26)}`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface ClaudeSettings {
  model?: string;
  hooks: { Notification: { hooks: { command: string }[] }[] };
}

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cord-hooks-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function config(): ConnectorConfig {
  return {
    server: 'https://cord.example.com',
    connector_id: `con_${'d'.repeat(20)}`,
    token: TOKEN,
    name: 'Laptop',
    agents: [
      {
        id: 'claude-code',
        label: 'Claude Code',
        kind: 'claude-code',
        command: 'claude',
        args: [],
        cwd: '/w',
      },
      { id: 'codex', label: 'Codex', kind: 'codex', command: 'codex', args: [], cwd: '/w' },
    ],
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A scripted gateway: the ring answer, then each long-poll answer in turn. */
function gateway(ring: Response, polls: Response[] = []) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchFn = (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') return Promise.resolve(ring);
    if (init.method === 'DELETE') return Promise.resolve(json(200, { status: 'cancelled' }));
    return Promise.resolve(polls.shift() ?? json(200, { status: 'pending' }));
  };
  return { fetch, calls };
}

const created = () => json(201, { invite_id: INVITE, expires_at: '2026-10-01T00:00:30.000Z' });

describe('cord-connect message', () => {
  function run(
    text: string,
    replies: (Response | Error)[],
    agent?: string,
    signal?: AbortSignal,
    retryMs: readonly number[] = [0],
  ) {
    const calls: RequestInit[] = [];
    const lines: string[] = [];
    const fetch: FetchFn = (_url, init) => {
      calls.push(init);
      const reply = replies.shift() ?? new Error('offline');
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve(reply);
    };
    const result = sendMessage(
      config(),
      { text, ...(agent !== undefined && { agent }) },
      {
        fetch,
        print: (line) => lines.push(line),
        retryMs,
        ...(signal !== undefined && { signal }),
      },
    );
    return { result, calls, lines };
  }

  it('refuses empty or too long text without calling the server', async () => {
    const empty = run('   ', []);
    expect(await empty.result).toBe(1);
    expect(empty.calls).toHaveLength(0);
    expect(empty.lines[0]).toMatch(/^Say what to send/);
    const long = run('x'.repeat(20_001), []);
    expect(await long.result).toBe(1);
    expect(long.calls).toHaveLength(0);
    expect(long.lines[0]).toMatch(/too long/);
  });

  it('explains a 404 and shows the server message for 401, without retrying', async () => {
    const missing = run('Done.', [json(404, {})]);
    expect(await missing.result).toBe(1);
    expect(missing.lines[0]).toMatch(/can't take messages yet/);
    const unlinked = run('Done.', [
      json(401, { error: { code: 'auth_required', message: 'Link this computer again.' } }),
    ]);
    expect(await unlinked.result).toBe(1);
    expect(unlinked.calls).toHaveLength(1);
    expect(unlinked.lines).toEqual(['Link this computer again.']);
  });

  it('sends trimmed text with an agent origin', async () => {
    const t = run('  Done.  ', [json(201, {})]);
    expect(await t.result).toBe(MESSAGE_EXIT.sent);
    expect(t.lines).toEqual(['Sent to your Twring chat.']);
    expect(JSON.parse(t.calls[0]!.body as string)).toEqual({
      local_agent: 'claude-code',
      text: 'Done.',
      origin: 'agent',
    });
    expect(t.calls[0]!.redirect).toBe('error');
  });

  it.each(['  ', 'x'.repeat(MAX_STORED_AGENT_MESSAGE_CHARS + 1)])(
    'rejects invalid text',
    async (text) => {
      const t = run(text, []);
      expect(await t.result).toBe(MESSAGE_EXIT.error);
      expect(t.calls).toHaveLength(0);
      expect(t.lines).toEqual([
        expect.stringMatching(text.trim() === '' ? /^Say what to send/ : /too long/),
      ]);
    },
  );

  it('rejects an unknown agent', async () => {
    const t = run('Done', [], 'missing');
    expect(await t.result).toBe(MESSAGE_EXIT.error);
    expect(t.calls).toHaveLength(0);
    expect(t.lines[0]).toContain('No agent "missing"');
  });

  it.each([404, 401])('handles %i without retry', async (status) => {
    const t = run('Done', [
      json(status, {
        error: { code: 'owner_unavailable', message: 'Pairing no longer valid', request_id: 'r' },
      }),
    ]);
    expect(await t.result).toBe(MESSAGE_EXIT.error);
    expect(t.calls).toHaveLength(1);
    expect(t.lines).toEqual([
      status === 404
        ? "This Twring server can't take messages yet, or this agent isn't saved there. Use ring instead."
        : 'Pairing no longer valid',
    ]);
  });

  it('retries 503 with the same idempotency key', async () => {
    const t = run('Done', [json(503, {}), json(201, {})]);
    expect(await t.result).toBe(MESSAGE_EXIT.sent);
    expect(t.calls).toHaveLength(2);
    const keys = t.calls.map((call) => (call.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('stops on 400', async () => {
    const t = run('Done', [
      json(400, { error: { code: 'owner_unavailable', message: 'Bad message', request_id: 'r' } }),
    ]);
    expect(await t.result).toBe(MESSAGE_EXIT.error);
    expect(t.lines).toEqual(['Bad message']);
    expect(t.calls).toHaveLength(1);
  });

  it('reports a network failure after the last retry', async () => {
    const t = run('Done', [new Error('offline'), new Error('still offline')]);
    expect(await t.result).toBe(MESSAGE_EXIT.error);
    expect(t.calls).toHaveLength(2);
    expect(t.lines).toEqual([
      'Could not reach https://cord.example.com. Check your internet connection.',
    ]);
  });

  it('aborts between retries', async () => {
    const stop = new AbortController();
    const t = run('Done', [json(503, {})], undefined, stop.signal, [1_000]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop.abort();
    expect(await t.result).toBe(MESSAGE_EXIT.error);
    expect(t.calls).toHaveLength(1);
    expect(t.lines).toEqual(['Message sending cancelled.']);
  });
});

async function ring(
  fetch: FetchFn,
  wait: boolean,
  extra: { agent?: string; session?: string } = {},
) {
  const lines: string[] = [];
  const code = await ringOwner(
    config(),
    { reason: 'Tests pass; push?', wait, ...extra },
    {
      fetch,
      print: (l) => lines.push(l),
    },
  );
  return { code, lines };
}

describe('cord-connect ring', () => {
  it('rings with the connector token, first agent, and session ref', async () => {
    const gw = gateway(created());
    const { code, lines } = await ring(gw.fetch, false, { session: 'sess-1' });
    expect(code).toBe(0);
    expect(lines).toEqual(['Ringing…']);
    const [call] = gw.calls;
    expect(call!.url).toBe('https://cord.example.com/v1/connectors/ring');
    expect((call!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(call!.init.body as string)).toEqual({
      local_agent: 'claude-code',
      reason: 'Tests pass; push?',
      session_ref: 'sess-1',
    });
  });

  it('drops a session ref that is not a plain id', async () => {
    const gw = gateway(created());
    await ring(gw.fetch, false, { session: 'a b;rm' });
    expect(JSON.parse(gw.calls[0]!.init.body as string)).not.toHaveProperty('session_ref');
  });

  it.each([
    [{ status: 'answered' }, 'Answered', RING_EXIT.answered],
    [{ status: 'declined', note: 'busy' }, 'Declined: busy', RING_EXIT.declined],
    [{ status: 'declined' }, 'Declined', RING_EXIT.declined],
    [{ status: 'missed' }, 'Missed: left a voicemail', RING_EXIT.missed],
    [{ status: 'cancelled' }, 'Cancelled', RING_EXIT.cancelled],
  ])('--wait long-polls until %o', async (outcome, line, exit) => {
    const gw = gateway(created(), [json(200, { status: 'pending' }), json(200, outcome)]);
    const { code, lines } = await ring(gw.fetch, true);
    expect(lines).toEqual(['Ringing…', line]);
    expect(code).toBe(exit);
    expect(gw.calls.filter((c) => c.init.method === 'GET')).toHaveLength(2);
    expect(gw.calls[1]!.url).toContain(`/v1/connectors/ring/${INVITE}?wait=25`);
  });

  it.each([
    'owner_unavailable',
    'owner_busy',
    'no_ring_phone',
    'ring_pending',
    'ring_rate_limited',
  ])('prints the refusal %s and exits 2', async (code) => {
    const message = `refused: ${code}`;
    const gw = gateway(json(409, { error: { code, message, request_id: 'r' } }));
    const out = await ring(gw.fetch, true);
    expect(out.lines).toEqual([message]);
    expect(out.code).toBe(RING_EXIT.refused);
  });

  it('an unknown --agent is an error before any request', async () => {
    const gw = gateway(created());
    const out = await ring(gw.fetch, false, { agent: 'nope' });
    expect(out.code).toBe(RING_EXIT.error);
    expect(gw.calls).toHaveLength(0);
  });

  async function ctrlC(deleteAnswer: () => Response) {
    const stop = new AbortController();
    const calls: string[] = [];
    const fetch: FetchFn = (_url, init) => {
      calls.push(init.method ?? '');
      if (init.method === 'POST') return Promise.resolve(created());
      if (init.method === 'DELETE') return Promise.resolve(deleteAnswer());
      stop.abort();
      return Promise.reject(new Error('aborted'));
    };
    const lines: string[] = [];
    const code = await ringOwner(
      config(),
      { reason: 'x', wait: true },
      {
        fetch,
        print: (l) => lines.push(l),
        signal: stop.signal,
      },
    );
    return { code, calls, lines };
  }

  it('Ctrl+C during --wait cancels the ring', async () => {
    const { code, calls, lines } = await ctrlC(() => json(200, { status: 'cancelled' }));
    expect(code).toBe(RING_EXIT.cancelled);
    expect(calls).toEqual(['POST', 'GET', 'DELETE']);
    expect(lines.at(-1)).toBe('Cancelled');
  });

  it.each([
    [{ status: 'answered' }, 'Answered', RING_EXIT.answered],
    [{ status: 'declined', note: 'in a meeting' }, 'Declined: in a meeting', RING_EXIT.declined],
    [{ status: 'missed' }, 'Missed: left a voicemail', RING_EXIT.missed],
  ])(
    'Ctrl+C after the owner already acted reports what DELETE says: %o',
    async (body, line, exit) => {
      const { code, lines } = await ctrlC(() => json(200, body));
      expect(lines.at(-1)).toBe(line);
      expect(code).toBe(exit);
    },
  );

  it('Ctrl+C with a failed or odd DELETE reply still says Cancelled', async () => {
    for (const answer of [
      () => json(500, {}),
      () => json(200, { status: 'pending' }),
      () => json(200, 'x'),
    ]) {
      const { code, lines } = await ctrlC(answer);
      expect(lines.at(-1)).toBe('Cancelled');
      expect(code).toBe(RING_EXIT.cancelled);
    }
  });
});

describe('ring --cancel (release test: an agent could not cancel its ring)', () => {
  it('a ring remembers its invite so it can be cancelled later', async () => {
    const gw = gateway(created());
    const remembered: string[] = [];
    const code = await ringOwner(
      config(),
      { reason: 'x', wait: false },
      {
        fetch: gw.fetch,
        print: () => undefined,
        remember: (id) => {
          remembered.push(id);
          return Promise.resolve();
        },
      },
    );
    expect(code).toBe(0);
    expect(remembered).toEqual([INVITE]);
  });

  async function cancel(lastRing: string | undefined, answer: () => Promise<Response>) {
    const calls: { url: string; method: string | undefined }[] = [];
    const lines: string[] = [];
    let forgot = false;
    const code = await cancelLastRing(config(), {
      fetch: (url, init) => {
        calls.push({ url, method: init.method });
        return answer();
      },
      print: (l) => lines.push(l),
      lastRing: () => Promise.resolve(lastRing),
      forget: () => {
        forgot = true;
        return Promise.resolve();
      },
    });
    return { code, calls, lines, forgot };
  }

  it('cancels the last ring that is still ringing', async () => {
    const out = await cancel(INVITE, () => Promise.resolve(json(200, { status: 'cancelled' })));
    expect(out.calls).toEqual([
      { url: `https://cord.example.com/v1/connectors/ring/${INVITE}`, method: 'DELETE' },
    ]);
    expect(out.lines).toEqual(['Cancelled']);
    expect(out.code).toBe(0);
    expect(out.forgot).toBe(true);
  });

  it('says how the ring ended when the owner already acted', async () => {
    const out = await cancel(INVITE, () => Promise.resolve(json(200, { status: 'answered' })));
    expect(out.lines).toEqual(['Answered']);
    expect(out.code).toBe(0);
  });

  it('with no ring to cancel, says so without a request', async () => {
    const out = await cancel(undefined, () => Promise.resolve(json(200, {})));
    expect(out.calls).toEqual([]);
    expect(out.lines).toEqual(['No ring to cancel.']);
    expect(out.code).toBe(RING_EXIT.refused);
  });

  it('offline: an error, and the ring is kept to cancel again', async () => {
    const out = await cancel(INVITE, () => Promise.reject(new Error('offline')));
    expect(out.code).toBe(RING_EXIT.error);
    expect(out.forgot).toBe(false);
    expect(out.lines[0]).toMatch(/Could not reach/);
  });
});

describe('--from-hook parsing', () => {
  it('claude: a Notification with message and session id', () => {
    expect(
      parseHookInput(
        'claude',
        JSON.stringify({
          session_id: 'abc-123',
          transcript_path: '/t.jsonl',
          cwd: '/w',
          hook_event_name: 'Notification',
          message: 'Claude needs your permission to use Bash',
        }),
      ),
    ).toEqual({
      reason: 'Claude needs your permission to use Bash',
      text: 'Claude needs your permission to use Bash',
      sessionRef: 'abc-123',
    });
  });

  it('claude: other events and junk ring nothing; no message falls back', () => {
    expect(parseHookInput('claude', JSON.stringify({ hook_event_name: 'Stop' }))).toBeUndefined();
    expect(parseHookInput('claude', 'not json')).toBeUndefined();
    expect(parseHookInput('claude', JSON.stringify({ hook_event_name: 'Notification' }))).toEqual({
      reason: 'Claude Code is waiting for you',
      text: 'Claude Code is waiting for you',
    });
  });

  it('claude: control and bidi characters are stripped, long text is cut to 140', () => {
    const out = parseHookInput(
      'claude',
      JSON.stringify({ message: `a‮b\u0007c ${'x'.repeat(300)}`, session_id: 'bad id!' }),
    );
    expect(out!.reason.startsWith('a b c')).toBe(true);
    expect(out!.reason.length).toBe(140);
    expect(out).not.toHaveProperty('sessionRef');
  });

  it('codex: agent-turn-complete with thread id and last message', () => {
    expect(
      parseHookInput(
        'codex',
        JSON.stringify({
          type: 'agent-turn-complete',
          'thread-id': 'th_1',
          'turn-id': 't',
          cwd: '/w',
          'input-messages': ['hi'],
          'last-assistant-message': 'Done: 3 files changed.',
        }),
      ),
    ).toEqual({
      reason: 'Done: 3 files changed.',
      text: 'Done: 3 files changed.',
      sessionRef: 'th_1',
    });
    expect(parseHookInput('codex', JSON.stringify({ type: 'other' }))).toBeUndefined();
  });

  it('codex: a message keeps the full reply; only the ring reason is cut', () => {
    const reply = `Done.\n${'Details. '.repeat(40)}`;
    const out = parseHookInput(
      'codex',
      JSON.stringify({ type: 'agent-turn-complete', 'last-assistant-message': reply }),
    );
    expect(out!.text).toBe(reply.trim());
    expect(out!.reason.length).toBeLessThanOrEqual(140);
  });
});

describe('hooks install/uninstall', () => {
  it('builds a message hook command', () => {
    expect(hookCommand('claude', 'message')).toBe('npx twring-connect message --from-hook claude');
  });

  it('claude: installs message, replaces it with ring, and uninstalls message', async () => {
    const home = await tempHome();
    const path = claudeSettingsPath(home);
    await installClaudeHook(home, 'message');
    expect(
      ((await readJson(path)) as ClaudeSettings).hooks.Notification[0]?.hooks[0]?.command,
    ).toBe(hookCommand('claude', 'message'));
    await installClaudeHook(home, 'ring');
    expect(
      ((await readJson(path)) as ClaudeSettings).hooks.Notification[0]?.hooks[0]?.command,
    ).toBe(hookCommand('claude'));
    await installClaudeHook(home, 'message');
    await uninstallClaudeHook(home);
    expect(await readJson(path)).toEqual({});
  });

  it('codex: installs message, replaces it with ring, and uninstalls message', async () => {
    const home = await tempHome();
    const path = codexConfigPath(home);
    await installCodexNotify(home, true, 'message');
    expect(await readFile(path, 'utf8')).toContain('"message", "--from-hook"');
    await installCodexNotify(home, true, 'ring');
    expect(await readFile(path, 'utf8')).toContain('"ring", "--from-hook"');
    await installCodexNotify(home, true, 'message');
    await uninstallCodexNotify(home);
    expect(await readFile(path, 'utf8')).toBe('');
  });
  it('claude: replaces a legacy hook with exactly one current hook', async () => {
    const home = await tempHome();
    const path = claudeSettingsPath(home);
    await mkdir(join(home, '.claude'), { recursive: true });
    const original = {
      hooks: {
        Notification: [
          { matcher: '', hooks: [{ type: 'command', command: 'say hi' }] },
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'npx cord-connect ring --from-hook claude' }],
          },
        ],
      },
    };
    await writeFile(path, JSON.stringify(original));

    await installClaudeHook(home);
    const settings = (await readJson(path)) as ClaudeSettings;
    expect(settings.hooks.Notification).toHaveLength(2);
    expect(settings.hooks.Notification[0]?.hooks[0]?.command).toBe('say hi');
    expect(settings.hooks.Notification[1]?.hooks[0]?.command).toBe(hookCommand('claude'));
    expect(await readJson(`${path}.cord-backup`)).toEqual(original);
  });

  it('claude: uninstalls a legacy hook', async () => {
    const home = await tempHome();
    const path = claudeSettingsPath(home);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        hooks: {
          Notification: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'npx cord-connect ring --from-hook claude' }],
            },
          ],
        },
      }),
    );

    await uninstallClaudeHook(home);
    expect(await readJson(path)).toEqual({});
  });

  it('claude: merges into existing settings, backs up, and is idempotent', async () => {
    const home = await tempHome();
    const path = claudeSettingsPath(home);
    await mkdir(join(home, '.claude'), { recursive: true });
    const original = {
      model: 'opus',
      hooks: { Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'say hi' }] }] },
    };
    await writeFile(path, JSON.stringify(original));

    const first = await installClaudeHook(home);
    expect(first.join('\n')).toContain('Backed up');
    const settings = (await readJson(path)) as ClaudeSettings;
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Notification).toHaveLength(2);
    expect(settings.hooks.Notification[1]?.hooks[0]?.command).toBe(hookCommand('claude'));
    expect(await readJson(`${path}.cord-backup`)).toEqual(original);

    expect((await installClaudeHook(home))[0]).toContain('Already installed');
    expect(((await readJson(path)) as ClaudeSettings).hooks.Notification).toHaveLength(2);

    await uninstallClaudeHook(home);
    expect(await readJson(path)).toEqual(original);
    expect((await uninstallClaudeHook(home))[0]).toContain('No Twring hook');
  });

  it('claude: creates the file in an empty home and refuses to touch invalid JSON', async () => {
    const home = await tempHome();
    await installClaudeHook(home);
    const path = claudeSettingsPath(home);
    expect(((await readJson(path)) as ClaudeSettings).hooks.Notification).toHaveLength(1);
    await uninstallClaudeHook(home);
    expect(await readJson(path)).toEqual({});
    await writeFile(path, '{ nope');
    await expect(installClaudeHook(home)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(path, 'utf8')).toBe('{ nope');
  });

  it('codex: off by default; with --on-turn-complete sets notify above tables, idempotent', async () => {
    const home = await tempHome();
    const path = codexConfigPath(home);
    await mkdir(join(home, '.codex'), { recursive: true });
    const original = 'model = "gpt-5"\n\n[profiles.fast]\nmodel = "mini"\n';
    await writeFile(path, original);

    expect((await installCodexNotify(home, false)).join(' ')).toContain('off by default');
    expect(await readFile(path, 'utf8')).toBe(original);

    await installCodexNotify(home, true);
    const text = await readFile(path, 'utf8');
    const lines = text.split('\n');
    const notifyAt = lines.findIndex((l) => l.startsWith('notify = '));
    expect(notifyAt).toBeGreaterThan(-1);
    expect(notifyAt).toBeLessThan(lines.indexOf('[profiles.fast]'));
    expect(lines[notifyAt]).toBe(
      'notify = ["npx", "twring-connect", "ring", "--from-hook", "codex"]',
    );

    expect((await installCodexNotify(home, true))[0]).toContain('Already installed');
    expect(await readFile(path, 'utf8')).toBe(text);

    await uninstallCodexNotify(home);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await uninstallCodexNotify(home))[0]).toContain('No Twring notify');
  });

  it('codex: never replaces someone else’s notify', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.codex'), { recursive: true });
    const original = 'notify = ["my-notifier"]\n';
    await writeFile(codexConfigPath(home), original);
    await expect(installCodexNotify(home, true)).rejects.toThrow(/another program/);
    expect((await uninstallCodexNotify(home))[0]).toContain('No Twring notify');
    expect(await readFile(codexConfigPath(home), 'utf8')).toBe(original);
  });
  it('codex: replaces a legacy notify line with the current command', async () => {
    const home = await tempHome();
    const path = codexConfigPath(home);
    await mkdir(join(home, '.codex'), { recursive: true });
    const original =
      'notify = ["npx", "cord-connect", "ring", "--from-hook", "codex"]\nmodel = "gpt-5"\n';
    await writeFile(path, original);

    await installCodexNotify(home, true);
    expect(await readFile(path, 'utf8')).toBe(
      'notify = ["npx", "twring-connect", "ring", "--from-hook", "codex"]\nmodel = "gpt-5"\n',
    );
    expect(await readFile(`${path}.cord-backup`, 'utf8')).toBe(original);
  });

  it('codex: uninstalls a legacy notify line', async () => {
    const home = await tempHome();
    const path = codexConfigPath(home);
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      path,
      'notify = ["npx", "cord-connect", "ring", "--from-hook", "codex"]\nmodel = "gpt-5"\n',
    );

    await uninstallCodexNotify(home);
    expect(await readFile(path, 'utf8')).toBe('model = "gpt-5"\n');
  });
});

async function collect(stream: AsyncIterable<LocalAgentEvent>): Promise<LocalAgentEvent[]> {
  const out: LocalAgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe('resume on answer', () => {
  it('claude-code: resumes a stored session and persists new sessions', () => {
    const args = buildClaudeArgs(READ_ONLY_TOOLS, undefined, 'sess-1');
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-1');
    expect(args).not.toContain('--no-session-persistence');
    expect(buildClaudeArgs(READ_ONLY_TOOLS)).not.toContain('--no-session-persistence');
  });

  it('claude-code: a failed resume starts a new session', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new ClaudeCodeAdapter({
      command: 'claude',
      cwd: '/w',
      tools: READ_ONLY_TOOLS,
      spawn,
      resume: 'gone',
      initTimeoutMs: 2_000,
    });
    const turn = collect(adapter.sendTurn('hi', new AbortController().signal)).catch(
      (e: unknown) => e,
    );
    const first = await spawned[0]!;
    expect(first.request.args).toContain('--resume');
    expect(adapter.sessionRef()).toBe('gone');
    first.exit(1);
    const second = await spawned[1]!;
    expect(second.request.args).not.toContain('--resume');
    expect(second.request.args).not.toContain('--no-session-persistence');
    second.out({ type: 'system', subtype: 'init', session_id: 'sess_new' });
    const init = await second.next((m) => m.type === 'control_request');
    second.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: init.request_id },
    });
    await second.next((m) => m.type === 'user');
    expect(adapter.sessionRef()).toBe('sess_new');
    adapter.close();
    await turn;
  });

  it('codex: resumes the thread; a resume that fails before any output runs in a new thread', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CodexAdapter({ command: 'codex', cwd: '/w', spawn, resume: 'th_9' });
    const turn = collect(adapter.sendTurn('why?', new AbortController().signal));
    const first = await spawned[0]!;
    expect(first.request.args.slice(0, 3)).toEqual(['exec', 'resume', 'th_9']);
    first.exit(1);
    const second = await spawned[1]!;
    expect(second.request.args).not.toContain('resume');
    second.out({ type: 'thread.started', thread_id: 'th_new' });
    second.out({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'ok' } });
    second.out({ type: 'turn.completed', usage: {} });
    second.exit(0);
    const out = await turn;
    expect(out).toContainEqual({ type: 'text', text: 'ok' });
  });

  async function acpStart(loadSession: boolean, loadFails = false) {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new AcpAdapter({
      command: 'gemini',
      args: ['--acp'],
      cwd: '/w',
      spawn,
      resume: 'sess_old',
    });
    void collect(adapter.sendTurn('hi', new AbortController().signal)).catch(() => undefined);
    cleanups.push(() => adapter.close());
    const child = await spawned[0]!;
    const init = await child.next((m) => m.method === 'initialize');
    child.out({
      jsonrpc: '2.0',
      id: init.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession } },
    });
    if (loadSession) {
      const load = await child.next((m) => m.method === 'session/load');
      expect(load.params).toEqual({ sessionId: 'sess_old', cwd: '/w', mcpServers: [] });
      child.out(
        loadFails
          ? { jsonrpc: '2.0', id: load.id, error: { code: -32000, message: 'unknown' } }
          : { jsonrpc: '2.0', id: load.id, result: null },
      );
    }
    return child;
  }

  it('acp: session/load when advertised', async () => {
    const child = await acpStart(true);
    const prompt = await child.next((m) => m.method === 'session/prompt');
    expect((prompt.params as { sessionId: string }).sessionId).toBe('sess_old');
  });

  it('acp: a new session when load is not advertised or fails', async () => {
    for (const [advertised, fails] of [
      [false, false],
      [true, true],
    ] as const) {
      const child = await acpStart(advertised, fails);
      const created = await child.next((m) => m.method === 'session/new');
      child.out({ jsonrpc: '2.0', id: created.id, result: { sessionId: 'sess_new' } });
      const prompt = await child.next((m) => m.method === 'session/prompt');
      expect((prompt.params as { sessionId: string }).sessionId).toBe('sess_new');
    }
  });

  it('createAdapter ignores a resume ref that is not a plain id', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = createAdapter(config().agents[1]!, spawn, '--bad ref');
    void collect(adapter.sendTurn('x', new AbortController().signal)).catch(() => undefined);
    const child = await spawned[0]!;
    expect(child.request.args).not.toContain('resume');
    adapter.close();
  });

  it.each([
    { fresh: false, expected: 'th_7' },
    { fresh: true, expected: undefined },
  ])(
    'the relay passes channel.open session choice to the pool (fresh=$fresh)',
    async ({ fresh, expected }) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => resolve());
          }),
      );
      await new Promise((resolve) => wss.once('listening', resolve));
      wss.on('connection', (ws) =>
        ws.on('message', (data: Buffer) => {
          const frame = JSON.parse(data.toString()) as { type: string };
          if (frame.type !== 'connector.hello') return;
          ws.send(
            JSON.stringify({
              type: 'connector.ready',
              protocol: 'cord-relay/1',
              connector_id: `con_${'a'.repeat(20)}`,
              name: 'Laptop',
            }),
          );
          ws.send(
            JSON.stringify({
              type: 'channel.open',
              channel: 'ch_1',
              agent: 'echo',
              resume_ref: 'th_7',
              ...(fresh && { fresh_session: true }),
            }),
          );
        }),
      );
      const seen: (string | undefined)[] = [];
      const fake: LocalAgentAdapter = {
        // eslint-disable-next-line require-yield, @typescript-eslint/require-await -- no turns here
        async *sendTurn() {
          return;
        },
        close() {},
      };
      const dir = await mkdtemp(join(tmpdir(), 'cord-ring-session-'));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const client = new RelayClient({
        url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/connectors/socket`,
        token: TOKEN,
        agents: [{ id: 'echo', label: 'Echo', kind: 'command' }],
        pool: new AgentPool({
          dir,
          createAdapter: (_id, resumeRef) => {
            seen.push(resumeRef);
            return fake;
          },
        }),
        onBackgroundResult: () => undefined,
        delaysMs: [10],
        random: () => 0,
      });
      cleanups.push(() => client.stop());
      client.start();
      const until = Date.now() + 3_000;
      while (seen.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
      expect(seen).toEqual([expected]);
    },
  );
});
