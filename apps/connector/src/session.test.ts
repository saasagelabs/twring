import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';
import { TEXT_TURN_TAG } from '@twring/contracts';

import { EventQueue, type LocalAgentAdapter, type LocalAgentEvent } from './events';
import { MAX_LINE_CHARS, lineTooLongError, readLines } from './process';
import { ChannelSession } from './session';
import { UploadError } from './upload';

/** An agent whose turn stays open until the test ends it; the test pushes its events. */
class ManualAdapter implements LocalAgentAdapter {
  queue = new EventQueue<LocalAgentEvent>();
  prompts: string[] = [];
  decisions: { id: string; decision: 'approve' | 'deny' }[] = [];
  decide(id: string, decision: 'approve' | 'deny'): void {
    this.decisions.push({ id, decision });
  }
  sendTurn(text: string, signal: AbortSignal): AsyncIterable<LocalAgentEvent> {
    this.prompts.push(text);
    signal.addEventListener('abort', () => this.queue.end(), { once: true });
    return this.queue;
  }
  close(): void {
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

function start(options: { keepAliveMs?: number; activityIntervalMs?: number } = {}) {
  const sent: Record<string, unknown>[] = [];
  const adapter = new ManualAdapter();
  const session = new ChannelSession({ adapter, send: (m) => sent.push(m), ...options });
  session.handle({
    type: 'user.turn',
    session_id: 's',
    turn_id: 't1',
    text: 'run the tests',
    started_at: 'x',
    committed_at: 'x',
  });
  const activities = () => sent.filter((m) => m.type === 'activity').map((m) => m.label);
  return { sent, adapter, session, activities };
}

describe('channel session: work after a call', () => {
  it('continues streaming text while a file upload is pending', async () => {
    const sent: Record<string, unknown>[] = [];
    const adapter = new ManualAdapter();
    let finishUpload!: (id: string) => void;
    const uploadFile = () =>
      new Promise<string>((resolve) => {
        finishUpload = resolve;
      });
    const session = new ChannelSession({ adapter, uploadFile, send: (m) => sent.push(m) });
    session.handle({
      type: 'user.turn',
      session_id: 's',
      turn_id: 'text',
      text: 'draw',
      surface: 'text',
      started_at: 'x',
      committed_at: 'x',
    });
    await waitFor(() => adapter.prompts.length === 1);
    adapter.queue.push({
      type: 'file',
      name: 'image-1.png',
      mimeType: 'image/png',
      data: Buffer.from('abc'),
    });
    await waitFor(() => sent.some((m) => m.type === 'activity' && m.label === 'Sending a file…'));
    adapter.queue.push({ type: 'text', text: 'Here it is.' });
    adapter.queue.end();
    await waitFor(() => sent.some((m) => m.type === 'text.delta'));
    expect(sent.some((m) => m.type === 'done')).toBe(false);
    finishUpload(`fil_${'a'.repeat(20)}`);
    await waitFor(() => sent.some((m) => m.type === 'done'));
    expect(sent.some((m) => m.type === 'file')).toBe(true);
  });
  it('uploads images on text turns after activity and skips failures; calls ignore images', async () => {
    const sent: Record<string, unknown>[] = [];
    const logged: string[] = [];
    const adapter = new ManualAdapter();
    const uploadFile = vi.fn(() => Promise.resolve(`fil_${'a'.repeat(20)}`));
    const session = new ChannelSession({
      adapter,
      uploadFile,
      send: (m) => sent.push(m),
      log: (m) => logged.push(m),
    });
    session.handle({
      type: 'user.turn',
      session_id: 's',
      turn_id: 'text',
      text: 'draw',
      surface: 'text',
      started_at: 'x',
      committed_at: 'x',
    });
    await waitFor(() => adapter.prompts.length === 1);
    adapter.queue.push({
      type: 'file',
      name: 'image-1.png',
      mimeType: 'image/png',
      data: Buffer.from('abc'),
    });
    await waitFor(() => sent.some((m) => m.type === 'file'));
    expect(
      sent.findIndex((m) => m.type === 'activity' && m.label === 'Sending a file…'),
    ).toBeLessThan(sent.findIndex((m) => m.type === 'file'));
    expect(sent.find((m) => m.type === 'file')).toMatchObject({ file_id: `fil_${'a'.repeat(20)}` });
    uploadFile.mockRejectedValueOnce(new UploadError('storage_full', 'full'));
    adapter.queue.push({
      type: 'file',
      name: 'image-2.png',
      mimeType: 'image/png',
      data: Buffer.from('abc'),
    });
    await waitFor(() => logged.includes('file upload failed (storage_full)'));
    expect(sent.filter((m) => m.type === 'file')).toHaveLength(1);
    adapter.queue.end();
    await waitFor(() => sent.some((m) => m.type === 'done'));

    const callSent: Record<string, unknown>[] = [];
    const callAdapter = new ManualAdapter();
    const call = new ChannelSession({
      adapter: callAdapter,
      uploadFile,
      send: (m) => callSent.push(m),
    });
    call.handle({
      type: 'user.turn',
      session_id: 's',
      turn_id: 'call',
      text: 'draw',
      started_at: 'x',
      committed_at: 'x',
    });
    await waitFor(() => callAdapter.prompts.length === 1);
    callAdapter.queue.push({
      type: 'file',
      name: 'image-1.png',
      mimeType: 'image/png',
      data: Buffer.from('abc'),
    });
    callAdapter.queue.end();
    await waitFor(() => callSent.some((m) => m.type === 'done'));
    expect(callSent.some((m) => m.type === 'file')).toBe(false);
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });
  it('starts at once, then reports a discovered boundary once, before the first event', async () => {
    const sent: Record<string, unknown>[] = [];
    let boundary = true;
    const adapter: LocalAgentAdapter = {
      async *sendTurn() {
        await Promise.resolve();
        yield { type: 'text', text: 'hello' } as const;
      },
      takeNewSession() {
        const value = boundary;
        boundary = false;
        return value;
      },
      close() {},
    };
    const session = new ChannelSession({ adapter, send: (message) => sent.push(message) });
    const turn = (turnId: string) =>
      session.handle({
        type: 'user.turn',
        session_id: 's',
        turn_id: turnId,
        text: 'hi',
        started_at: 'x',
        committed_at: 'x',
      });
    turn('one');
    await waitFor(() => sent.some((message) => message.type === 'done'));
    turn('two');
    await waitFor(() => sent.filter((message) => message.type === 'done').length === 2);
    // Turn one: run.started at once (the gateway's sign of life), then the boundary before the
    // text. Turn two: run.started only.
    const one = sent.filter((message) => message.turn_id === 'one').map((m) => m.type);
    expect(one.slice(0, 3)).toEqual(['run.started', 'run.started', 'text.start']);
    expect(
      sent
        .filter((message) => message.type === 'run.started')
        .map((message) => message.new_session),
    ).toEqual([undefined, true, undefined]);
    const seqs = sent.filter((m) => m.turn_id === 'one').map((m) => m.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  const turn = {
    type: 'user.turn',
    session_id: 's',
    turn_id: 't1',
    text: 'do the work',
    started_at: 'x',
    committed_at: 'x',
  };

  function running(
    backgroundTurnMaxMs = 30 * 60_000,
    surface?: 'call' | 'text',
    backgroundTalkMs = 0,
  ) {
    const sent: Record<string, unknown>[] = [];
    const results: { text: string; turn: { turnId: string; surface: 'call' | 'text' } }[] = [];
    const logs: string[] = [];
    const adapter = new ManualAdapter();
    let signal: AbortSignal | undefined;
    const original = adapter.sendTurn.bind(adapter);
    adapter.sendTurn = (text, s) => {
      signal = s;
      return original(text, s);
    };
    const session = new ChannelSession({
      adapter,
      send: (m) => sent.push(m),
      onBackgroundResult: (text, turn) => results.push({ text, turn }),
      log: (line) => logs.push(line),
      backgroundTurnMaxMs,
      backgroundTalkMs,
    });
    session.handle({ ...turn, ...(surface !== undefined && { surface }) });
    return {
      sent,
      results,
      logs,
      adapter,
      session,
      get signal() {
        return signal;
      },
    };
  }

  it('detaches, stops frames, and reports only the text said after the call', async () => {
    const t = running();
    await waitFor(() => t.signal !== undefined);
    t.adapter.queue.push({ type: 'text', text: 'First ' });
    await waitFor(() => t.sent.some((m) => m.type === 'text.delta'));
    t.session.close();
    const count = t.sent.length;
    expect(t.signal?.aborted).toBe(false);
    t.adapter.queue.push({ type: 'text', text: 'second.' });
    t.adapter.queue.end();
    await waitFor(() => t.results.length === 1);
    expect(t.sent).toHaveLength(count);
    expect(t.results).toEqual([{ text: 'second.', turn: { turnId: 't1', surface: 'call' } }]);
    expect(t.logs).toContain('turn continues after the call');
    expect(t.logs.some((line) => /^background turn done in \d+ ms$/.test(line))).toBe(true);
  });

  it('drops a goodbye still being said at hang-up, so it never rings', async () => {
    const t = running(30 * 60_000, 'call', 60_000);
    await waitFor(() => t.signal !== undefined);
    t.session.close();
    t.adapter.queue.push({ type: 'text', text: 'Okay, bye!' });
    t.adapter.queue.end();
    await waitFor(() => t.logs.includes('background turn was only talk; not delivered'));
    expect(t.results).toEqual([]);
  });

  it('still delivers a quick result when the turn used a tool', async () => {
    const t = running(30 * 60_000, 'call', 60_000);
    await waitFor(() => t.signal !== undefined);
    t.adapter.queue.push({ type: 'tool.start', id: 'x', name: 'Bash' });
    t.session.close();
    t.adapter.queue.push({ type: 'tool.end', id: 'x', status: 'success' });
    t.adapter.queue.push({ type: 'text', text: 'Tests pass.' });
    t.adapter.queue.end();
    await waitFor(() => t.results.length === 1);
    expect(t.results[0]?.text).toBe('Tests pass.');
  });

  it('tags typed prompts and lets a detached text turn finish without ringing', async () => {
    const t = running(30 * 60_000, 'text');
    await waitFor(() => t.signal !== undefined);
    expect(t.adapter.prompts).toEqual([`${TEXT_TURN_TAG}\ndo the work`]);
    t.session.close();
    t.adapter.queue.push({ type: 'text', text: 'Written answer.' });
    t.adapter.queue.end();
    await waitFor(() => t.logs.some((line) => /^background text turn done in \d+ ms$/.test(line)));
    expect(t.results).toEqual([
      { text: 'Written answer.', turn: { turnId: 't1', surface: 'text' } },
    ]);
    expect(t.signal?.aborted).toBe(false);
  });

  it('logs a detached text turn that ends without a result', async () => {
    const t = running(30 * 60_000, 'text');
    await waitFor(() => t.signal !== undefined);
    t.session.close();
    t.adapter.queue.end();
    await waitFor(() => t.logs.includes('background text turn ended without a result'));
    expect(t.results).toEqual([]);
  });

  it('leaves call prompts untagged', async () => {
    const t = running();
    await waitFor(() => t.signal !== undefined);
    expect(t.adapter.prompts).toEqual(['do the work']);
    t.session.close();
    t.adapter.queue.end();
  });

  it('treats the gateway cancelling as the call ends as a hang-up, not a stop', async () => {
    const t = running();
    await waitFor(() => t.signal !== undefined);
    t.session.handle({ type: 'turn.cancel', turn_id: 't1', reason: 'call_ended' });
    expect(t.signal?.aborted).toBe(false);
    expect(t.logs).toContain('turn continues after the call');
    t.adapter.queue.push({ type: 'text', text: 'The report is ready.' });
    t.adapter.queue.end();
    await waitFor(() => t.results.length === 1);
    expect(t.results).toEqual([
      { text: 'The report is ready.', turn: { turnId: 't1', surface: 'call' } },
    ]);
  });

  it('does not report an owner-cancelled turn', async () => {
    const t = running();
    await waitFor(() => t.signal !== undefined);
    t.session.handle({ type: 'turn.cancel', turn_id: 't1', reason: 'barge_in' });
    t.session.close();
    await waitFor(() => t.logs.includes('background turn ended without a result'));
    expect(t.signal?.aborted).toBe(true);
    expect(t.results).toEqual([]);
  });

  it('denies an approval already pending and one arriving after detach', async () => {
    const t = running();
    await waitFor(() => t.signal !== undefined);
    t.adapter.queue.push({
      type: 'approval.required',
      id: 'apr_1',
      action: 'edit_files',
      title: 'Edit',
    });
    await waitFor(() => t.sent.some((m) => m.type === 'approval.required'));
    t.session.close();
    expect(t.adapter.decisions).toEqual([{ id: 'apr_1', decision: 'deny' }]);
    t.adapter.queue.push({
      type: 'approval.required',
      id: 'apr_2',
      action: 'run_command',
      title: 'Run',
    });
    await waitFor(() => t.adapter.decisions.length === 2);
    expect(t.adapter.decisions[1]).toEqual({ id: 'apr_2', decision: 'deny' });
    t.adapter.queue.end();
  });

  it('aborts a detached turn at the deadline', async () => {
    const t = running(50);
    await waitFor(() => t.signal !== undefined);
    vi.useFakeTimers();
    try {
      t.session.close();
      await vi.advanceTimersByTimeAsync(50);
      expect(t.signal?.aborted).toBe(true);
      expect(t.results).toEqual([]);
      expect(t.logs).toContain('background turn ended without a result');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report empty or failed turns', async () => {
    const empty = running();
    await waitFor(() => empty.signal !== undefined);
    empty.session.close();
    empty.adapter.queue.end();
    await waitFor(() => empty.logs.includes('background turn ended without a result'));
    expect(empty.results).toEqual([]);
    const failed = running();
    await waitFor(() => failed.signal !== undefined);
    failed.session.close();
    failed.adapter.queue.end(new Error('failed'));
    await waitFor(() => failed.logs.includes('background turn ended without a result'));
    expect(failed.results).toEqual([]);
  });
});

describe('channel session: keep-alive while the agent works quietly', () => {
  it('relays an approval decision only to the active turn', async () => {
    const { adapter, session, sent } = start();
    await waitFor(() => sent.some((m) => m.type === 'run.started'));
    adapter.queue.push({
      type: 'approval.required',
      id: 'apr_1',
      action: 'edit_files',
      title: 'Edit',
    });
    await waitFor(() => sent.some((m) => m.type === 'approval.required'));
    session.handle({
      type: 'approval.decision',
      turn_id: 'wrong',
      approval_id: 'apr_1',
      decision: 'approve',
    });
    expect(adapter.decisions).toEqual([]);
    session.handle({
      type: 'approval.decision',
      turn_id: 't1',
      approval_id: 'apr_1',
      decision: 'approve',
    });
    expect(adapter.decisions).toEqual([{ id: 'apr_1', decision: 'approve' }]);
    session.close();
  });
  it('sends an activity keep-alive after each quiet interval, naming the running tool', async () => {
    const { adapter, session, sent, activities } = start({ keepAliveMs: 40 });
    await waitFor(() => sent.some((m) => m.type === 'run.started'));
    adapter.queue.push({ type: 'tool.start', id: 'x', name: 'Bash', label: 'Running a command' });
    await waitFor(() => activities().length >= 3);
    expect(new Set(activities())).toEqual(new Set(['Running a command']));
    // Every keep-alive is an ordinary, ordered event of this turn: no text, no speech.
    expect(sent.some((m) => m.type === 'text.delta')).toBe(false);
    const seqs = sent.map((m) => m.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    adapter.queue.end();
    await waitFor(() => sent.some((m) => m.type === 'done'));
    const count = sent.length;
    await sleep(120);
    // Nothing more once the turn is done.
    expect(sent).toHaveLength(count);
    session.close();
  });

  it('says "Working…" when the agent never said what it is doing, and stops on cancel', async () => {
    const { session, sent, activities } = start({ keepAliveMs: 30 });
    await waitFor(() => activities().length >= 1);
    expect(activities()[0]).toBe('Working…');
    session.handle({ type: 'turn.cancel', turn_id: 't1', reason: 'barge_in' });
    await waitFor(() => sent.some((m) => m.type === 'done'));
    const count = sent.length;
    await sleep(100);
    expect(sent).toHaveLength(count);
    session.close();
  });

  it('a busy agent gets no extra keep-alives', async () => {
    const { adapter, session, sent, activities } = start({ keepAliveMs: 80 });
    for (let i = 0; i < 6; i++) {
      adapter.queue.push({ type: 'text', text: `word${i} ` });
      await sleep(20);
    }
    expect(activities()).toEqual([]);
    adapter.queue.end();
    await waitFor(() => sent.some((m) => m.type === 'done'));
    session.close();
  });
});

describe('channel session: a turn waiting behind another', () => {
  const turn = (turn_id: string) => ({
    type: 'user.turn',
    session_id: 's',
    turn_id,
    text: 'what did I just type?',
    started_at: 'x',
    committed_at: 'x',
  });

  /** The agent is busy with another channel's turn until `release` is called. */
  function queuedBehindAnother() {
    const sent: Record<string, unknown>[] = [];
    const adapter = new ManualAdapter();
    let release!: () => void;
    const busy = new Promise<void>((resolve) => (release = resolve));
    const session = new ChannelSession({
      adapter,
      send: (m) => sent.push(m),
      keepAliveMs: 20,
      runExclusive: (fn) => busy.then(fn),
    });
    return { sent, adapter, session, release };
  }

  it('says it is finishing the last message, then starts with a continuing seq', async () => {
    const t = queuedBehindAnother();
    t.session.handle(turn('t1'));
    await waitFor(() => t.sent.length >= 2);
    expect(t.sent.slice(0, 2)).toMatchObject([
      { type: 'activity', label: 'Finishing your last message…', turn_id: 't1', seq: 0 },
      { type: 'activity', label: 'Finishing your last message…', turn_id: 't1', seq: 1 },
    ]);
    t.release();
    await waitFor(() => t.sent.some((m) => m.type === 'run.started'));
    const seqs = t.sent.map((m) => m.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const waited = t.sent.length;
    await sleep(60);
    expect(t.sent.slice(waited).some((m) => m.label === 'Finishing your last message…')).toBe(
      false,
    );
    t.adapter.queue.end();
  });

  it('goes quiet when the queued turn is cancelled or the channel closes', async () => {
    const cancelled = queuedBehindAnother();
    cancelled.session.handle(turn('t1'));
    cancelled.session.handle({ type: 'turn.cancel', turn_id: 't1', reason: 'timeout' });
    const closed = queuedBehindAnother();
    closed.session.handle(turn('t1'));
    closed.session.close();
    await sleep(80);
    expect(cancelled.sent).toEqual([]);
    expect(closed.sent).toEqual([]);
    cancelled.release();
    closed.release();
  });
});

describe('channel session: activity floods are coalesced', () => {
  it('sends at most one label per interval, and the latest label wins', async () => {
    const { adapter, session, sent, activities } = start({
      keepAliveMs: 10_000,
      activityIntervalMs: 60,
    });
    for (let i = 0; i < 200; i++) adapter.queue.push({ type: 'activity', label: `step ${i}` });
    await waitFor(() => activities().includes('step 199'));
    // The first goes out at once, then the flood collapses to its last value.
    expect(activities()).toEqual(['step 0', 'step 199']);
    adapter.queue.end();
    await waitFor(() => sent.some((m) => m.type === 'done'));
    session.close();
  });

  it('a label still waiting is dropped when the turn ends (no stale label after done)', async () => {
    const { adapter, session, sent, activities } = start({
      keepAliveMs: 10_000,
      activityIntervalMs: 200,
    });
    adapter.queue.push({ type: 'activity', label: 'first' });
    adapter.queue.push({ type: 'activity', label: 'second' });
    await waitFor(() => activities().length === 1);
    adapter.queue.end();
    await waitFor(() => sent.some((m) => m.type === 'done'));
    await sleep(250);
    expect(activities()).toEqual(['first']);
    expect(sent.at(-1)).toMatchObject({ type: 'done' });
    session.close();
  });
});

describe('readLines: bounded lines', () => {
  it('passes ordinary lines through, including CRLF and a last line without a newline', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    readLines(stream, (line) => lines.push(line));
    stream.write('one\r\ntw');
    stream.write('o\nthree');
    stream.end();
    await waitFor(() => lines.length === 3);
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('reports a line over the cap once, skips it, and keeps reading the next lines', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    let overflows = 0;
    readLines(
      stream,
      (line) => lines.push(line),
      () => (overflows += 1),
      100,
    );
    stream.write('ok\n');
    for (let i = 0; i < 10; i++) stream.write('x'.repeat(50)); // 500 chars, no newline yet
    stream.write('tail\nafter\n');
    await waitFor(() => lines.length === 2);
    expect(lines).toEqual(['ok', 'after']);
    expect(overflows).toBe(1);
  });

  it('caps a single line at about 1 MB by default with a clear error for the turn', () => {
    expect(MAX_LINE_CHARS).toBe(1_000_000);
    expect(lineTooLongError()).toMatchObject({ code: 'line_too_long' });
    expect(lineTooLongError().message).toMatch(/longer than 1 MB/);
  });
});
