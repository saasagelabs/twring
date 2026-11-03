import { describe, expect, it, vi } from 'vitest';

import { ACP_APPROVAL_TIMEOUT_MS, AcpAdapter } from './adapters/acp';
import { EventQueue, type LocalAgentAdapter, type LocalAgentEvent } from './events';
import { fakeSpawner, type FakeChild } from './fake-child';
import { ChannelSession } from './session';

// Verifier pass (ADR-029): the connector holds the agent's permission request until the gateway
// decides, and answers it exactly once, on every exit path.

function ready() {
  const { spawn, spawned } = fakeSpawner();
  const adapter = new AcpAdapter({
    command: 'hermes',
    args: ['acp'],
    cwd: '/work',
    spawn,
    cancelTimeoutMs: 200,
  });
  return { adapter, spawned };
}

async function handshake(child: FakeChild) {
  const init = await child.next((m) => m.method === 'initialize');
  child.out({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  const session = await child.next((m) => m.method === 'session/new');
  child.out({ jsonrpc: '2.0', id: session.id, result: { sessionId: 'sess_1' } });
  return child.next((m) => m.method === 'session/prompt');
}

const OPTIONS = [
  { optionId: 'yes', kind: 'allow_once' },
  { optionId: 'always', kind: 'allow_always' },
  { optionId: 'no', kind: 'reject_once' },
];

/** A turn with one permission request (JSON-RPC id 91) held for the owner. */
async function held(options: unknown[] = OPTIONS) {
  const { adapter, spawned } = ready();
  const abort = new AbortController();
  const iterator = adapter.sendTurn('clean up', abort.signal)[Symbol.asyncIterator]();
  const first = iterator.next();
  const child = (await spawned[0]) as FakeChild;
  const prompt = await handshake(child);
  child.out({
    jsonrpc: '2.0',
    id: 91,
    method: 'session/request_permission',
    params: { sessionId: 'sess_1', toolCall: { kind: 'delete', title: 'rm -rf build' }, options },
  });
  const event = (await first).value as LocalAgentEvent;
  if (event.type !== 'approval.required') throw new Error('expected an approval');
  return { adapter, child, prompt, iterator, abort, approvalId: event.id };
}

const answers = (child: FakeChild, id: number) =>
  child.written.filter(
    (m): m is Record<string, unknown> =>
      typeof m === 'object' && m !== null && (m as { id?: unknown }).id === id && 'result' in m,
  );

describe('acp: a held permission request is answered exactly once', () => {
  it('ids are unguessable and unique per request', async () => {
    const a = await held();
    const b = await held();
    expect(a.approvalId).toMatch(/^apr_[a-z2-7]{20}$/);
    expect(a.approvalId).not.toBe(b.approvalId);
    a.adapter.close();
    b.adapter.close();
  });

  it('a second decision, a wrong id, and a decision after the answer change nothing', async () => {
    const { adapter, child, approvalId } = await held();
    adapter.decide('apr_wrong', 'approve');
    adapter.decide(approvalId, 'deny');
    adapter.decide(approvalId, 'approve');
    await child.next((m) => m.id === 91);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answers(child, 91).map((m) => m.result)).toEqual([
      { outcome: { outcome: 'selected', optionId: 'no' } },
    ]);
    adapter.close();
  });

  it('approve never picks allow_always; with no allow_once it is cancelled, not allowed', async () => {
    const { adapter, child, approvalId } = await held([
      { optionId: 'always', kind: 'allow_always' },
      { optionId: 'no', kind: 'reject_once' },
    ]);
    adapter.decide(approvalId, 'approve');
    expect((await child.next((m) => m.id === 91)).result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    adapter.close();
  });

  it('closing the connector (relay drop, call end) denies the held request', async () => {
    const { adapter, child } = await held();
    adapter.close();
    expect((await child.next((m) => m.id === 91)).result).toEqual({
      outcome: { outcome: 'selected', optionId: 'no' },
    });
    expect(answers(child, 91)).toHaveLength(1);
  });

  it('the agent finishing its prompt while asking denies the request', async () => {
    const { adapter, child, prompt, iterator } = await held();
    child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    expect((await child.next((m) => m.id === 91)).result).toEqual({
      outcome: { outcome: 'selected', optionId: 'no' },
    });
    expect((await iterator.next()).done).toBe(true);
    adapter.close();
  });

  it('a decision after the 125 s fallback is ignored', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { adapter, child, approvalId } = await held();
      await vi.advanceTimersByTimeAsync(ACP_APPROVAL_TIMEOUT_MS);
      adapter.decide(approvalId, 'approve');
      await vi.advanceTimersByTimeAsync(10);
      expect(answers(child, 91).map((m) => m.result)).toEqual([
        { outcome: { outcome: 'selected', optionId: 'no' } },
      ]);
      adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** An agent whose turn stays open until the test ends it. */
class ManualAdapter implements LocalAgentAdapter {
  queue = new EventQueue<LocalAgentEvent>();
  decisions: { id: string; decision: 'approve' | 'deny' }[] = [];
  closed = false;
  decide(id: string, decision: 'approve' | 'deny'): void {
    this.decisions.push({ id, decision });
  }
  sendTurn(_text: string, signal: AbortSignal): AsyncIterable<LocalAgentEvent> {
    signal.addEventListener('abort', () => this.queue.end(), { once: true });
    return this.queue;
  }
  close(): void {
    this.closed = true;
    this.queue.end();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await sleep(2);
  }
}

function session(keepAliveMs = 30) {
  const sent: Record<string, unknown>[] = [];
  const adapter = new ManualAdapter();
  const channel = new ChannelSession({ adapter, send: (m) => sent.push(m), keepAliveMs });
  channel.handle({
    type: 'user.turn',
    session_id: 's',
    turn_id: 't1',
    text: 'clean up',
    started_at: 'x',
    committed_at: 'x',
  });
  return { sent, adapter, channel };
}

describe('channel session while an approval waits', () => {
  it('keep-alives go on while the owner decides, so the gateway idle budget never ends the turn', async () => {
    const { sent, adapter, channel } = session(30);
    await waitFor(() => sent.some((m) => m.type === 'run.started'));
    adapter.queue.push({
      type: 'approval.required',
      id: 'apr_1',
      action: 'edit_files',
      title: 'E',
    });
    await waitFor(() => sent.some((m) => m.type === 'approval.required'));
    const at = sent.length;
    await waitFor(() => sent.slice(at).filter((m) => m.type === 'activity').length >= 2);
    channel.close();
  });

  it('a decision for a turn that was superseded never reaches the agent', async () => {
    const { sent, adapter, channel } = session();
    await waitFor(() => sent.some((m) => m.type === 'run.started'));
    adapter.queue.push({
      type: 'approval.required',
      id: 'apr_1',
      action: 'edit_files',
      title: 'E',
    });
    await waitFor(() => sent.some((m) => m.type === 'approval.required'));
    channel.handle({ type: 'turn.cancel', turn_id: 't1', reason: 'superseded' });
    await waitFor(() => sent.some((m) => m.type === 'done'));
    channel.handle({
      type: 'approval.decision',
      turn_id: 't1',
      approval_id: 'apr_1',
      decision: 'approve',
    });
    expect(adapter.decisions).toEqual([]);
    channel.close();
  });

  it('a malformed decision is ignored', async () => {
    const { sent, adapter, channel } = session();
    await waitFor(() => sent.some((m) => m.type === 'run.started'));
    for (const decision of ['yes', 'allow_always', undefined])
      channel.handle({ type: 'approval.decision', turn_id: 't1', approval_id: 'apr_1', decision });
    channel.handle({ type: 'approval.decision', turn_id: 't1', decision: 'approve' });
    expect(adapter.decisions).toEqual([]);
    channel.close();
    expect(adapter.closed).toBe(false);
  });
});
