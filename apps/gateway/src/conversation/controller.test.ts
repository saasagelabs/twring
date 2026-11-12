import { AdapterError, type TwringAgentAdapter } from '@twring/agent-adapter';
import {
  AGENT_HANGUP_LINGER_MS,
  MAX_STATUS_MESSAGE_BYTES,
  statusMessageSchema,
  type AgentEvent,
  type StatusMessage,
  type UserTurn,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { ManualScheduler, flushMicrotasks, recordingLogger } from '../calls/testing';

import {
  AGENT_TIMEOUTS,
  ConversationController,
  FLOOR_CONTROL_WORDS,
  MAX_MERGED_TURN_CHARS,
  MAX_STOP_REQUEST_WORDS,
  MAX_USER_TURN_CHARS,
  SHORT_BARGE_IN_GRACE_MS,
  STOP_REQUEST_WORDS,
  isFloorControl,
  isStopRequest,
  type ConversationOptions,
  type SpeechOutput,
} from './controller';
import { ECHO_FINISHED_TAIL_MS, ECHO_TAIL_MS, echoWords } from './echo';
import {
  APPROVAL_DENIED_LINE,
  APPROVAL_REASK,
  APPROVAL_TIMEOUT_LINE,
  APPROVAL_TIMEOUT_MS,
  approvalVoiceDecision,
} from './approvals';
import {
  ACK_LINES,
  ACK_LINE_AFTER_MS,
  CUE_FINISH_GRACE_MS,
  GENERIC_PROGRESS_LINE,
  GENERIC_PROGRESS_LINE_AFTER_MS,
  MAX_PROGRESS_LINES,
  MAX_SPOKEN_LABEL_CHARS,
  OPENING_TURN_QUIET_MS,
  PRESENCE_TONE_AFTER_MS,
  PROGRESS_LINE_AFTER_MS,
  PROGRESS_LINE_REPEAT_MS,
  STOPPED_LINE,
  ackLine,
  progressLine,
  spokenActivityLabel,
} from './presence';

const CALL_ID = 'call_aaaaaaaaaaaaaaaaaaaa';

/** One turn's event stream that a test feeds by hand. */
class Channel implements AsyncIterable<AgentEvent> {
  private readonly queue: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private finished = false;
  private error: Error | undefined;
  seq = 0;

  constructor(
    readonly turn: UserTurn,
    readonly signal: AbortSignal,
  ) {
    signal.addEventListener('abort', () => this.fail(signal.reason));
  }

  push(event: Omit<AgentEvent, 'event_id' | 'turn_id' | 'seq'> & Partial<AgentEvent>): void {
    this.seq += 1;
    this.queue.push({
      event_id: `evt_${this.seq}`,
      turn_id: this.turn.turnId,
      seq: this.seq,
      ...event,
    } as AgentEvent);
    this.wake?.();
  }

  text(delta: string): void {
    this.push({ type: 'text.delta', message_id: 'm', delta });
  }

  done(): void {
    this.push({ type: 'done', status: 'completed' });
  }

  end(): void {
    this.finished = true;
    this.wake?.();
  }

  fail(error: unknown): void {
    this.error = error instanceof Error ? error : new Error('failed');
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.error !== undefined) throw this.error;
      if (this.finished) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

class ScriptedAdapter implements TwringAgentAdapter {
  name = 'scripted';
  readonly capabilities = {
    streamingText: true,
    cancellation: true,
    resumableStream: false,
    activityEvents: true,
    toolEvents: true,
    approvals: false,
    conversationResume: false,
    serverInitiatedCalls: false,
  };
  readonly channels: Channel[] = [];
  readonly cancelled: string[] = [];
  readonly approvalDecisions: { id: string; decision: 'approve' | 'deny' }[] = [];
  closed = 0;

  connect(): Promise<void> {
    return Promise.resolve();
  }

  sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const channel = new Channel(turn, signal);
    this.channels.push(channel);
    return channel;
  }

  cancelTurn(turnId: string): Promise<void> {
    this.cancelled.push(turnId);
    return Promise.resolve();
  }

  decideApproval(_turnId: string, id: string, decision: 'approve' | 'deny'): Promise<void> {
    this.approvalDecisions.push({ id, decision });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }
}

class RecordingSpeech implements SpeechOutput {
  readonly calls: string[] = [];
  private n = 0;
  begin(): string {
    this.n += 1;
    this.calls.push(`begin gen_${this.n}`);
    return `gen_${this.n}`;
  }
  append(id: string, text: string): void {
    this.calls.push(`append ${id} ${text}`);
  }
  end(id: string): void {
    this.calls.push(`end ${id}`);
  }
  cancel(reason: string): void {
    this.calls.push(`cancel ${reason}`);
  }
  /** What the pipeline would report as the caller's voice onset. */
  onsetAt: number | undefined;
  callerOnsetAt(): number | undefined {
    return this.onsetAt;
  }
  /** Playout the pipeline would report, per generation (ms). */
  readonly played = new Map<string, number>();
  readonly totals = new Map<string, number>();
  playedMs(id: string): number {
    return this.played.get(id) ?? 0;
  }
  totalAudioMs(id: string): number | undefined {
    return this.totals.get(id);
  }
}

function setup(
  adapter: ScriptedAdapter = new ScriptedAdapter(),
  onAgentUnusable?: (code: string) => void,
  timeouts?: ConversationOptions['timeouts'],
  extra: Partial<
    Pick<ConversationOptions, 'agentName' | 'presenceCues' | 'shortTurnHoldMs' | 'wallClock'>
  > = {},
) {
  const speech = new RecordingSpeech();
  const scheduler = new ManualScheduler();
  const logger = recordingLogger();
  const sent: StatusMessage[] = [];
  const conversation = new ConversationController({
    callId: CALL_ID,
    adapter,
    speech,
    scheduler,
    logger,
    send: (message) => sent.push(message),
    wallClock: () => Date.UTC(2026, 8, 26, 12, 0, 0),
    ...(onAgentUnusable === undefined ? {} : { onAgentUnusable }),
    ...(timeouts === undefined ? {} : { timeouts }),
    ...extra,
  });
  const floors = () =>
    sent.flatMap((m) =>
      m.type === 'floor' ? [m.floor + (m.activity !== undefined ? `(${m.activity})` : '')] : [],
    );
  const of = <T extends StatusMessage['type']>(type: T) =>
    sent.filter((m): m is Extract<StatusMessage, { type: T }> => m.type === type);
  return { adapter, speech, scheduler, logger, sent, conversation, floors, of };
}

describe('live approvals', () => {
  it.each([
    ['yes', 'approve'],
    ['Hermes, go ahead', 'approve'],
    ['no', 'deny'],
    ['Hermes, not now', 'deny'],
  ] as const)('classifies %s as %s', (text, decision) => {
    expect(approvalVoiceDecision(text, 'Hermes')).toBe(decision);
  });

  it('publishes and speaks a fixed prompt, accepts voice yes once, and resumes progress', async () => {
    const { adapter, conversation, speech, sent, scheduler } = setup(
      undefined,
      undefined,
      undefined,
      { agentName: 'Hermes', presenceCues: true },
    );
    conversation.userTurn('do it');
    await flushMicrotasks();
    adapter.channels[0]!.push({
      type: 'approval.required',
      approval_id: 'apr_1',
      action: 'delete_files',
      title: 'Delete secret files',
    });
    await flushMicrotasks();
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'approval',
        approval_id: 'apr_1',
        action: 'delete_files',
        title: 'Delete secret files',
      }),
    );
    expect(speech.calls.join(' ')).toContain(
      'Hermes wants to delete files. Say yes or no, or tap on your phone.',
    );
    expect(speech.calls.join(' ')).not.toContain('secret files');
    scheduler.advance(5_000);
    expect(speech.calls.join(' ')).not.toContain('Still working');
    conversation.userTurn('Hermes, go ahead');
    expect(adapter.approvalDecisions).toEqual([{ id: 'apr_1', decision: 'approve' }]);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'approval_resolved',
        approval_id: 'apr_1',
        decision: 'approve',
        by: 'voice',
      }),
    );
    expect(conversation.resolveApproval('apr_1', 'deny', 'tap')).toBe(false);
    expect(speech.calls.join(' ')).not.toContain(APPROVAL_DENIED_LINE);
    scheduler.advance(GENERIC_PROGRESS_LINE_AFTER_MS);
    expect(speech.calls.join(' ')).toContain('Still working');
    conversation.close();
  });

  it('re-asks once, never forwards unclear speech, and speaks after a voice denial', async () => {
    const { adapter, conversation, speech } = setup();
    conversation.userTurn('go');
    await flushMicrotasks();
    adapter.channels[0]!.push({
      type: 'approval.required',
      approval_id: 'apr_2',
      action: 'run_command',
      title: 'Untrusted command',
    });
    await flushMicrotasks();
    conversation.userTurn('maybe later');
    conversation.userTurn('what is that');
    expect(speech.calls.filter((line) => line.includes(APPROVAL_REASK))).toHaveLength(1);
    expect(adapter.channels).toHaveLength(1);
    conversation.userTurn('no');
    expect(adapter.approvalDecisions).toEqual([{ id: 'apr_2', decision: 'deny' }]);
    expect(speech.calls.join(' ')).toContain(APPROVAL_DENIED_LINE);
    conversation.close();
  });

  it('denies on timeout, stop, and call end', async () => {
    for (const outcome of ['timeout', 'stop', 'call_end'] as const) {
      const { adapter, conversation, scheduler, speech, sent } = setup();
      conversation.userTurn('go');
      await flushMicrotasks();
      adapter.channels[0]!.push({
        type: 'approval.required',
        approval_id: 'apr_3',
        action: 'read_files',
        title: 'Read',
      });
      await flushMicrotasks();
      if (outcome === 'timeout') scheduler.advance(APPROVAL_TIMEOUT_MS);
      else if (outcome === 'stop') conversation.userTurn('stop');
      else conversation.close();
      expect(adapter.approvalDecisions).toEqual([{ id: 'apr_3', decision: 'deny' }]);
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'approval_resolved', by: outcome }),
      );
      if (outcome === 'timeout') expect(speech.calls.join(' ')).toContain(APPROVAL_TIMEOUT_LINE);
      conversation.close();
    }
  });
});

describe('ConversationController', () => {
  it('runs one natural turn: working, activity, speaking, back to listening', async () => {
    const { adapter, speech, conversation, floors, of } = setup();
    conversation.userSpeechStarted();
    conversation.userTurn('check my calendar');
    await flushMicrotasks();
    const agent = adapter.channels[0]!;
    expect(agent.turn).toMatchObject({
      callId: CALL_ID,
      turnId: 'turn_1',
      role: 'user',
      text: 'check my calendar',
      committedAt: '2026-09-26T12:00:00.000Z',
    });

    agent.push({
      type: 'tool.start',
      tool_call_id: 't',
      tool_name: 'cal.get',
      display_label: 'Checking calendar…',
    });
    await flushMicrotasks();
    agent.push({ type: 'tool.end', tool_call_id: 't', status: 'success' });
    agent.text('You have ');
    agent.text('two meetings.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls).toEqual([
      'begin gen_1',
      'append gen_1 You have ',
      'append gen_1 two ',
      'append gen_1 meetings.',
      'end gen_1',
    ]);

    conversation.speechState('gen_1', 'playing');
    conversation.speechState('gen_1', 'finished');
    expect(floors()).toEqual([
      'user_speaking',
      'agent_working',
      'agent_working(Checking calendar…)',
      'agent_working',
      'agent_speaking',
      'listening',
    ]);
    expect(of('agent_text').at(-1)).toMatchObject({ text: 'You have two meetings.', final: true });
    expect(of('floor').map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('stays working until the answer has played out, not just until the agent is done', async () => {
    const { adapter, conversation, floors } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    adapter.channels[0]!.text('Hello.');
    adapter.channels[0]!.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    expect(floors().at(-1)).toBe('agent_speaking');
    conversation.speechState('gen_1', 'finished');
    expect(floors().at(-1)).toBe('listening');
  });

  it('a reply with nothing speakable completes without starting speech', async () => {
    const { adapter, speech, conversation, floors } = setup();
    conversation.userTurn('code please');
    await flushMicrotasks();
    adapter.channels[0]!.text('```\nls -la\n```\n');
    adapter.channels[0]!.done();
    await flushMicrotasks();
    expect(speech.calls).toEqual([]);
    expect(floors().at(-1)).toBe('listening');
  });

  it('a new committed turn supersedes the old one: speech stops, agent cancelled', async () => {
    const { adapter, speech, conversation, floors } = setup();
    conversation.userTurn('tell me a story');
    await flushMicrotasks();
    adapter.channels[0]!.text('Once upon ');
    await flushMicrotasks();
    conversation.userTurn('stop, what time is it');
    await flushMicrotasks();
    expect(speech.calls).toContain('cancel superseded');
    expect(adapter.cancelled).toEqual(['turn_1']);
    expect(adapter.channels[0]!.signal.aborted).toBe(true);
    expect(adapter.channels).toHaveLength(2);
    expect(floors().at(-1)).toBe('agent_working');

    // Late events from the old turn never reach speech.
    const before = speech.calls.length;
    adapter.channels[0]!.text('a time');
    await flushMicrotasks();
    expect(speech.calls).toHaveLength(before);
  });

  it('noise that never becomes words hands the floor back', () => {
    const { conversation, floors } = setup();
    conversation.userSpeechStarted();
    conversation.userSpeechDiscarded();
    expect(floors()).toEqual(['user_speaking', 'listening']);
  });

  it('times out an agent that never answers, tells the caller, and listens again', async () => {
    const { adapter, conversation, scheduler, floors, of } = setup();
    conversation.userTurn('simulate silence');
    await flushMicrotasks();
    scheduler.advance(AGENT_TIMEOUTS.firstEventMs);
    await flushMicrotasks();
    expect(of('notice')).toEqual([
      { v: 1, type: 'notice', call_id: CALL_ID, code: 'agent_timeout' },
    ]);
    expect(adapter.channels[0]!.signal.aborted).toBe(true);
    expect(floors().at(-1)).toBe('listening');
  });

  it('times out an agent that stalls mid-answer, keeping what it already said', async () => {
    const { adapter, speech, conversation, scheduler, of } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    adapter.channels[0]!.text('Half an ');
    await flushMicrotasks();
    scheduler.advance(AGENT_TIMEOUTS.idleMs);
    await flushMicrotasks();
    expect(of('notice')[0]?.code).toBe('agent_timeout');
    expect(speech.calls.at(-1)).toBe('end gen_1');
  });

  it('an agent error ends the turn with a notice', async () => {
    const { adapter, conversation, floors, of } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    adapter.channels[0]!.push({ type: 'error', code: 'upstream_down' });
    await flushMicrotasks();
    expect(of('notice')[0]?.code).toBe('agent_failed');
    expect(floors().at(-1)).toBe('listening');
  });

  it('a stream that ends without done, or that throws, fails the turn', async () => {
    for (const finish of ['end', 'throw'] as const) {
      const { adapter, conversation, of, floors } = setup();
      conversation.userTurn('hi');
      await flushMicrotasks();
      if (finish === 'end') adapter.channels[0]!.end();
      else adapter.channels[0]!.fail(new Error('socket reset'));
      await flushMicrotasks();
      expect(of('notice')[0]?.code).toBe('agent_failed');
      expect(floors().at(-1)).toBe('listening');
    }
  });

  it('drops duplicate events and fails the turn when seq goes backwards', async () => {
    const { adapter, speech, conversation, of } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    const agent = adapter.channels[0]!;
    agent.push({
      type: 'text.delta',
      message_id: 'm',
      delta: 'One ',
      event_id: 'a',
      seq: 5,
    });
    agent.push({
      type: 'text.delta',
      message_id: 'm',
      delta: 'One ',
      event_id: 'a',
      seq: 5,
    });
    await flushMicrotasks();
    expect(speech.calls.filter((c) => c.startsWith('append'))).toEqual(['append gen_1 One ']);
    agent.push({
      type: 'text.delta',
      message_id: 'm',
      delta: 'two ',
      event_id: 'b',
      seq: 4,
    });
    await flushMicrotasks();
    expect(of('notice')[0]?.code).toBe('agent_failed');
  });

  it('throttles visible text updates while the reply streams', async () => {
    const { adapter, conversation, scheduler, of } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    for (let i = 0; i < 10; i += 1) adapter.channels[0]!.text(`w${i} `);
    await flushMicrotasks();
    expect(of('agent_text')).toHaveLength(1);
    scheduler.advance(150);
    expect(of('agent_text')).toHaveLength(2);
    expect(of('agent_text')[1]?.text).toBe('w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 ');
  });

  it('closing mid-turn aborts the agent run and closes the adapter', async () => {
    const { adapter, conversation, sent } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    const count = sent.length;
    conversation.close();
    expect(adapter.channels[0]!.signal.aborted).toBe(true);
    expect(adapter.cancelled).toEqual(['turn_1']);
    expect(adapter.closed).toBe(1);
    conversation.userTurn('ignored');
    expect(sent).toHaveLength(count);
  });

  it('never logs what was said', async () => {
    const { adapter, conversation, logger } = setup();
    conversation.userTurn('my secret plan');
    await flushMicrotasks();
    adapter.channels[0]!.text('Your secret is safe.');
    adapter.channels[0]!.done();
    await flushMicrotasks();
    expect(JSON.stringify(logger.events)).not.toMatch(/secret/);
  });
});

/** A turn stream that ignores its abort signal, like a misbehaving remote agent. */
class StubbornChannel extends Channel {
  override fail(_error: unknown): void {
    // Keeps streaming after Twring gave up on the turn.
  }
}

class StubbornAdapter extends ScriptedAdapter {
  override sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const channel = new StubbornChannel(turn, signal);
    this.channels.push(channel);
    return channel;
  }
}

describe('ConversationController: agents that work quietly', () => {
  it('keep-alive activity holds a long quiet tool run open without speech', async () => {
    const { adapter, speech, conversation, scheduler, floors, of } = setup();
    conversation.userTurn('run the test suite');
    await flushMicrotasks();
    const agent = adapter.channels[0]!;
    agent.push({
      type: 'tool.start',
      tool_call_id: 't',
      tool_name: 'Bash',
      display_label: 'Running a command',
    });
    await flushMicrotasks();
    // A tool that prints nothing for two minutes; the connector says "still working" every 10 s.
    for (let s = 0; s < 12; s++) {
      scheduler.advance(10_000);
      agent.push({ type: 'activity', label: 'Running a command' });
      await flushMicrotasks();
    }
    expect(of('notice')).toEqual([]);
    expect(speech.calls).toEqual([]);
    expect(floors().at(-1)).toBe('agent_working(Running a command)');
    agent.push({ type: 'tool.end', tool_call_id: 't', status: 'success' });
    agent.text('All tests pass. ');
    agent.done();
    await flushMicrotasks();
    expect(of('notice')).toEqual([]);
  });

  it('without keep-alives, a quiet agent still times out after the idle budget', async () => {
    const { adapter, conversation, scheduler, of } = setup();
    conversation.userTurn('run the test suite');
    await flushMicrotasks();
    adapter.channels[0]!.push({ type: 'tool.start', tool_call_id: 't', tool_name: 'Bash' });
    await flushMicrotasks();
    scheduler.advance(AGENT_TIMEOUTS.idleMs);
    await flushMicrotasks();
    expect(of('notice')[0]?.code).toBe('agent_timeout');
  });

  it('a hung agent that only sends keep-alives still ends at the hard turn cap', async () => {
    const { adapter, conversation, scheduler, of } = setup(undefined, undefined, {
      totalMs: 600_000,
    });
    conversation.userTurn('do the thing');
    await flushMicrotasks();
    const agent = adapter.channels[0]!;
    for (let s = 0; s < 59; s++) {
      scheduler.advance(10_000);
      agent.push({ type: 'activity', label: 'Working…' });
      await flushMicrotasks();
    }
    expect(of('notice')).toEqual([]);
    scheduler.advance(10_000);
    await flushMicrotasks();
    expect(of('notice')[0]?.code).toBe('agent_timeout');
  });
});

describe('ConversationController edge cases (verifier)', () => {
  it('an agent that ignores abort after a timeout cannot speak, show text, or change the floor', async () => {
    const { adapter, speech, conversation, scheduler, floors, of } = setup(new StubbornAdapter());
    conversation.userTurn('hi');
    await flushMicrotasks();
    const agent = adapter.channels[0]!;
    agent.text('Half an ');
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    scheduler.advance(AGENT_TIMEOUTS.idleMs);
    await flushMicrotasks();
    expect(of('notice')[0]?.code).toBe('agent_timeout');
    expect(speech.calls.at(-1)).toBe('end gen_1');
    expect(of('agent_text').at(-1)?.final).toBe(true);
    const floorsBefore = floors();

    // The agent keeps going although Twring gave up on the turn (its audio is still playing out).
    agent.text('hour late. ');
    agent.push({ type: 'tool.start', tool_call_id: 't', tool_name: 'x', display_label: 'Late…' });
    await flushMicrotasks();
    scheduler.advance(200);
    await flushMicrotasks();

    expect(speech.calls.at(-1)).toBe('end gen_1');
    expect(of('agent_text').at(-1)?.final).toBe(true);
    expect(floors()).toEqual(floorsBefore);
  });

  it('once the agent is done and has spoken, no agent timer is left to fire', async () => {
    const { adapter, conversation, scheduler, of, floors } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    adapter.channels[0]!.text('Hello there. ');
    adapter.channels[0]!.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    conversation.speechState('gen_1', 'finished');
    expect(scheduler.pending).toBe(0);
    scheduler.advance(AGENT_TIMEOUTS.totalMs * 2);
    await flushMicrotasks();
    expect(of('notice')).toEqual([]);
    expect(floors().at(-1)).toBe('listening');
  });

  it('closing with a throttled text update pending sends nothing more and leaves no timers', async () => {
    const { adapter, conversation, scheduler, sent } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    adapter.channels[0]!.text('one ');
    adapter.channels[0]!.text('two ');
    await flushMicrotasks();
    const count = sent.length;
    conversation.close();
    conversation.close();
    expect(scheduler.pending).toBe(0);
    scheduler.advance(AGENT_TIMEOUTS.totalMs);
    conversation.speechState('gen_1', 'finished');
    conversation.userSpeechStarted();
    conversation.userSpeechDiscarded();
    conversation.resendFloor();
    await flushMicrotasks();
    expect(sent).toHaveLength(count);
  });

  it("a superseded turn's late speech callbacks never move the new turn's floor", async () => {
    const { adapter, conversation, floors } = setup();
    conversation.userTurn('first');
    await flushMicrotasks();
    adapter.channels[0]!.text('Answer one. ');
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    conversation.userTurn('second');
    await flushMicrotasks();
    expect(floors().at(-1)).toBe('agent_working');
    conversation.speechState('gen_1', 'playing');
    conversation.speechState('gen_1', 'finished');
    conversation.speechState('gen_1', 'failed');
    expect(floors().at(-1)).toBe('agent_working');
    adapter.channels[1]!.text('Answer two. ');
    adapter.channels[1]!.done();
    await flushMicrotasks();
    conversation.speechState('gen_2', 'playing');
    conversation.speechState('gen_2', 'finished');
    expect(floors().slice(-2)).toEqual(['agent_speaking', 'listening']);
  });

  it('when speech fails while the agent is still answering, the floor stops claiming it speaks', async () => {
    const { adapter, conversation, floors } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    adapter.channels[0]!.text('Part one ');
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    expect(floors().at(-1)).toBe('agent_speaking');
    conversation.speechState('gen_1', 'failed');
    // Nothing is audible any more and the agent is still working on its answer.
    expect(floors().at(-1)).toBe('agent_working');
  });

  it('when the agent finishes while the caller is already talking, the floor goes to the caller', async () => {
    const { adapter, conversation, floors } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    adapter.channels[0]!.text('Hello. ');
    adapter.channels[0]!.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    conversation.userSpeechStarted(); // caller starts talking over the tail of the answer
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    conversation.speechState('gen_1', 'finished');
    expect(floors().at(-1)).toBe('user_speaking');
  });

  it('every status message it sends is one the phone accepts (schema)', async () => {
    const { adapter, conversation, sent } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    // A typed adapter can still produce values outside the wire contract's bounds.
    adapter.channels[0]!.push({ type: 'activity', label: `Searching ${'the web '.repeat(12)}` });
    await flushMicrotasks();
    const rejected = sent.filter((m) => !statusMessageSchema.safeParse(m).success);
    expect(rejected).toEqual([]);
  });

  it('a full-length reply always fits in one status packet, whatever characters it has', async () => {
    const cases = {
      cjk: '天'.repeat(2000),
      quotesAndNewlines: '"\\\n'.repeat(700),
      controlChars: '\u0001'.repeat(2000),
    };
    const fits: Record<string, boolean> = {};
    for (const [name, reply] of Object.entries(cases)) {
      const { adapter, conversation, of } = setup();
      conversation.userTurn('hi');
      await flushMicrotasks();
      for (let i = 0; i < reply.length; i += 1000) {
        adapter.channels[0]!.text(reply.slice(i, i + 1000));
      }
      adapter.channels[0]!.done();
      await flushMicrotasks();
      const last = of('agent_text').at(-1)!;
      fits[name] =
        new TextEncoder().encode(JSON.stringify(last)).byteLength <= MAX_STATUS_MESSAGE_BYTES;
    }
    expect(fits).toEqual({ cjk: true, quotesAndNewlines: true, controlChars: true });
  });

  it('clipping a long reply never leaves half of a surrogate pair', async () => {
    const { adapter, conversation, of } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    adapter.channels[0]!.text('😀'.repeat(800)); // 1600 UTF-16 units
    adapter.channels[0]!.done();
    await flushMicrotasks();
    const text = of('agent_text').at(-1)!.text;
    expect(text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });
});

/** A turn whose answer is playing out: `Part one ` spoken so far, the agent still answering. */
async function speaking() {
  const ctx = setup();
  ctx.conversation.userTurn('tell me a story');
  await flushMicrotasks();
  const agent = ctx.adapter.channels[0]!;
  agent.text('Part one ');
  await flushMicrotasks();
  ctx.conversation.speechState('gen_1', 'playing');
  expect(ctx.floors().at(-1)).toBe('agent_speaking');
  return { ...ctx, agent };
}

describe('ConversationController barge-in (ADR-015)', () => {
  it('caller speech over the answer stops it at once and gives the caller the floor', async () => {
    const { adapter, speech, conversation, floors, agent, logger, scheduler } = await speaking();
    speech.onsetAt = scheduler.now();
    scheduler.advance(240);
    conversation.userSpeechStarted();
    scheduler.advance(60);
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
    expect(floors().slice(-2)).toEqual(['agent_speaking', 'user_speaking']);
    // Only a committed turn cancels the agent: the caller may just be saying "uh-huh".
    expect(agent.signal.aborted).toBe(false);
    expect(adapter.cancelled).toEqual([]);
    expect(logger.events.find((e) => e.fields.event === 'barge_in')?.fields).toEqual({
      event: 'barge_in',
      call_id: CALL_ID,
      turn_id: 'turn_1',
      generation_id: 'gen_1',
      detect_ms: 240,
      confirm_ms: 60,
    });
  });

  it('omits detect_ms when no voice onset was seen', async () => {
    const { conversation, logger } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    const fields = logger.events.find((e) => e.fields.event === 'barge_in')?.fields;
    expect(fields).toBeDefined();
    expect(fields).not.toHaveProperty('detect_ms');
  });

  it('the interrupted answer never resumes, though its text still reaches the phone', async () => {
    const { speech, conversation, floors, agent, of } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    const callsAtBargeIn = speech.calls.length;
    agent.text('and part two.');
    await flushMicrotasks();
    conversation.userSpeechDiscarded(); // it was only noise
    expect(floors().at(-1)).toBe('agent_working');
    agent.text(' And the end.');
    agent.done();
    await flushMicrotasks();
    // Late playback callbacks from the cut generation change nothing.
    conversation.speechState('gen_1', 'playing');
    conversation.speechState('gen_1', 'finished');
    expect(speech.calls.slice(callsAtBargeIn)).toEqual([]);
    expect(floors().slice(-3)).toEqual(['user_speaking', 'agent_working', 'listening']);
    expect(floors().filter((f) => f === 'agent_speaking')).toHaveLength(1);
    expect(of('agent_text').at(-1)).toMatchObject({
      text: 'Part one and part two. And the end.',
      final: true,
    });
  });

  it('a turn committed after the barge-in supersedes the old one: agent aborted and cancelled', async () => {
    const { adapter, speech, conversation, floors, agent } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    conversation.userTurn('wait, what about tomorrow');
    await flushMicrotasks();
    expect(agent.signal.aborted).toBe(true);
    expect(adapter.cancelled).toEqual(['turn_1']);
    // Speech was already cancelled at the barge-in; nothing is left to cancel.
    expect(speech.calls.filter((c) => c.startsWith('cancel'))).toEqual(['cancel barge_in']);
    expect(floors().slice(-2)).toEqual(['user_speaking', 'agent_working']);
  });

  it('barging in on an answer the agent already finished ends the turn with the caller talking', async () => {
    const { conversation, floors, agent } = await speaking();
    agent.done();
    await flushMicrotasks();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    expect(floors().slice(-2)).toEqual(['agent_speaking', 'user_speaking']);
    conversation.speechState('gen_1', 'finished');
    conversation.userSpeechDiscarded();
    expect(floors().at(-1)).toBe('listening');
  });

  it('speech not yet audible is cut the same way', async () => {
    const { adapter, speech, conversation, floors } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    adapter.channels[0]!.text('Hello there ');
    await flushMicrotasks();
    conversation.userSpeechStarted(); // TTS has the text but nothing has played yet
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
    conversation.speechState('gen_1', 'playing');
    expect(floors().at(-1)).toBe('user_speaking');
    expect(floors()).not.toContain('agent_speaking');
  });
});

describe('ConversationController caller talking over a working agent (ADR-015)', () => {
  async function working() {
    const ctx = setup();
    ctx.conversation.userTurn('check the weather');
    await flushMicrotasks();
    ctx.conversation.userSpeechStarted();
    expect(ctx.floors().slice(-2)).toEqual(['agent_working', 'user_speaking']);
    return { ...ctx, agent: ctx.adapter.channels[0]! };
  }

  it('holds the answer while the caller talks, and plays it if that was noise', async () => {
    const { speech, conversation, agent, floors, of } = await working();
    agent.text('It is sunny ');
    await flushMicrotasks();
    expect(speech.calls).toEqual([]);
    expect(of('agent_text').at(-1)?.text).toBe('It is sunny ');
    conversation.userSpeechDiscarded();
    expect(speech.calls).toEqual(['begin gen_1', 'append gen_1 It is sunny ']);
    expect(floors().at(-1)).toBe('agent_working');
    agent.text('today.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls.slice(2)).toEqual(['append gen_1 today.', 'end gen_1']);
    conversation.speechState('gen_1', 'playing');
    conversation.speechState('gen_1', 'finished');
    expect(floors().slice(-2)).toEqual(['agent_speaking', 'listening']);
  });

  it('an answer the agent finished while held waits for the caller, then plays in full', async () => {
    const { speech, conversation, agent, floors } = await working();
    agent.text('It is sunny.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls).toEqual([]);
    expect(floors().at(-1)).toBe('user_speaking'); // not complete: the held answer is still owed
    conversation.userSpeechDiscarded();
    expect(speech.calls).toEqual(['begin gen_1', 'append gen_1 It is sunny.', 'end gen_1']);
    expect(floors().at(-1)).toBe('agent_working');
    conversation.speechState('gen_1', 'playing');
    conversation.speechState('gen_1', 'finished');
    expect(floors().slice(-2)).toEqual(['agent_speaking', 'listening']);
  });

  it('a committed turn drops the held answer and supersedes the agent', async () => {
    const { adapter, speech, conversation, agent, floors } = await working();
    agent.text('It is sunny ');
    await flushMicrotasks();
    conversation.userTurn('actually, never mind');
    await flushMicrotasks();
    expect(speech.calls).toEqual([]);
    expect(agent.signal.aborted).toBe(true);
    expect(adapter.cancelled).toEqual(['turn_1']);
    expect(floors().at(-1)).toBe('agent_working');
    adapter.channels[1]!.text('Okay.');
    adapter.channels[1]!.done();
    await flushMicrotasks();
    expect(speech.calls).toEqual(['begin gen_1', 'append gen_1 Okay.', 'end gen_1']);
  });

  it('an agent with nothing speakable finishes while the caller talks and leaves them the floor', async () => {
    const { conversation, agent, floors } = await working();
    agent.done();
    await flushMicrotasks();
    expect(floors().at(-1)).toBe('user_speaking');
    conversation.userSpeechDiscarded();
    expect(floors().at(-1)).toBe('listening');
  });
});

describe('ConversationController barge-in edge cases (verifier)', () => {
  it('a second speech-start while the caller already has the floor cancels nothing more', async () => {
    const { speech, conversation, logger } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    conversation.userSpeechStarted();
    expect(speech.calls.filter((c) => c.startsWith('cancel'))).toEqual(['cancel barge_in']);
    expect(logger.names().filter((n) => n === 'barge_in')).toHaveLength(1);
  });

  it('speech-start with no turn in progress is not a barge-in', () => {
    const { speech, conversation, logger, floors } = setup();
    conversation.userSpeechStarted();
    expect(speech.calls).toEqual([]);
    expect(logger.names()).not.toContain('barge_in');
    expect(floors()).toEqual(['user_speaking']);
  });

  it('barge-in, then noise, then the agent finishes: nothing more spoken, no notice, no timers', async () => {
    const { speech, conversation, agent, floors, of, scheduler } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    const callsAtBargeIn = speech.calls.length;
    conversation.userSpeechDiscarded();
    expect(floors().at(-1)).toBe('agent_working');
    agent.text('More words.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls.slice(callsAtBargeIn)).toEqual([]);
    expect(floors().at(-1)).toBe('listening');
    expect(of('notice')).toEqual([]);
    expect(scheduler.pending).toBe(0);
  });

  it('barge-in, the agent finishes while the caller talks, then their turn commits: no supersede', async () => {
    const { adapter, conversation, agent, logger, floors } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    agent.done();
    await flushMicrotasks();
    // The muted turn is over as soon as the agent is: nothing is owed to the caller.
    expect(floors().at(-1)).toBe('user_speaking');
    conversation.userTurn('what about next week');
    await flushMicrotasks();
    expect(logger.names()).not.toContain('agent_turn_superseded');
    expect(adapter.cancelled).toEqual([]);
    expect(floors().at(-1)).toBe('agent_working');
  });

  it('late failed/playing/finished callbacks for the cut generation never move the floor', async () => {
    const { conversation, floors, agent } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    const before = floors();
    conversation.speechState('gen_1', 'failed');
    conversation.speechState('gen_1', 'playing');
    conversation.speechState('gen_1', 'finished');
    expect(floors()).toEqual(before);
    expect(agent.signal.aborted).toBe(false);
  });

  it('an agent that times out after the barge-in still ends the turn and clears its timers', async () => {
    const { conversation, scheduler, floors, of } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    conversation.userSpeechDiscarded();
    scheduler.advance(AGENT_TIMEOUTS.idleMs);
    await flushMicrotasks();
    expect(of('notice').map((n) => n.code)).toEqual(['agent_timeout']);
    expect(floors().at(-1)).toBe('listening');
    expect(scheduler.pending).toBe(0);
  });

  it('when speech failed (TTS reconnecting) the caller talking holds, rather than cuts, the answer', async () => {
    const { speech, conversation, agent, logger, floors } = await speaking();
    conversation.speechState('gen_1', 'failed');
    conversation.userSpeechStarted();
    expect(logger.names()).not.toContain('barge_in');
    agent.text('Later words.');
    await flushMicrotasks();
    expect(speech.calls.filter((c) => c.includes('Later'))).toEqual([]);
    conversation.userSpeechDiscarded();
    expect(speech.calls.slice(-2)).toEqual(['begin gen_2', 'append gen_2 Later ']);
    expect(floors().at(-1)).toBe('agent_working');
  });

  it('never logs what was said on the barge-in and held-speech paths', async () => {
    const { conversation, agent, logger } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    agent.text('secret words ');
    conversation.userSpeechDiscarded();
    agent.done();
    await flushMicrotasks();
    conversation.userTurn('my secret plan');
    await flushMicrotasks();
    conversation.userSpeechStarted();
    await flushMicrotasks();
    expect(JSON.stringify(logger.events)).not.toMatch(/secret|Part one/);
  });

  // ADR-015: a spoken preamble's generation is closed at the tool boundary, so once it has played
  // out, a cough during the silent tool call only holds speech; it cuts nothing and mutes nothing.
  it('noise during a tool call after a spoken preamble does not mute the rest of the answer', async () => {
    const { speech, conversation, agent, floors, logger } = await speaking();
    agent.push({
      type: 'tool.start',
      tool_call_id: 't',
      tool_name: 'x',
      display_label: 'Looking…',
    });
    await flushMicrotasks();
    expect(speech.calls.at(-1)).toBe('end gen_1');
    expect(floors().at(-1)).toBe('agent_speaking'); // the preamble is still playing out
    conversation.speechState('gen_1', 'finished');
    expect(floors().at(-1)).toBe('agent_working(Looking…)');
    conversation.userSpeechStarted(); // a cough in the silence
    conversation.userSpeechDiscarded();
    expect(logger.names()).not.toContain('barge_in');
    agent.push({ type: 'tool.end', tool_call_id: 't', status: 'success' });
    agent.text('Here is the answer.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls.slice(-4)).toEqual([
      'begin gen_2',
      'append gen_2 Here is the ',
      'append gen_2 answer.',
      'end gen_2',
    ]);
    conversation.speechState('gen_2', 'playing');
    conversation.speechState('gen_2', 'finished');
    expect(floors().slice(-2)).toEqual(['agent_speaking', 'listening']);
  });

  it("a preamble's unfinished last word goes out with it at the tool boundary", async () => {
    const { speech, conversation, agent } = await speaking();
    agent.text('Let me check that.');
    agent.push({ type: 'activity', label: 'Searching…' });
    await flushMicrotasks();
    expect(speech.calls.slice(-3)).toEqual([
      'append gen_1 Let me check ',
      'append gen_1 that.',
      'end gen_1',
    ]);
    conversation.speechState('gen_1', 'finished');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls.at(-1)).toBe('end gen_1'); // nothing new to say
  });

  it('text arriving while the preamble still plays out waits for it, then starts the next generation', async () => {
    const { speech, conversation, agent, floors } = await speaking();
    agent.push({ type: 'tool.start', tool_call_id: 't', tool_name: 'x' });
    agent.push({ type: 'tool.end', tool_call_id: 't', status: 'success' });
    agent.text('The answer is ');
    await flushMicrotasks();
    expect(speech.calls.at(-1)).toBe('end gen_1'); // held: gen_1 takes no more text
    conversation.speechState('gen_1', 'finished');
    expect(speech.calls.slice(-2)).toEqual(['begin gen_2', 'append gen_2 The answer is ']);
    expect(floors().at(-1)).toBe('agent_working');
    agent.text('four.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls.slice(-2)).toEqual(['append gen_2 four.', 'end gen_2']);
    conversation.speechState('gen_2', 'playing');
    conversation.speechState('gen_2', 'finished');
    expect(floors().at(-1)).toBe('listening');
  });

  it('the agent finishing while the ended preamble plays out speaks the held rest afterwards', async () => {
    const { speech, conversation, agent, floors } = await speaking();
    agent.push({ type: 'tool.start', tool_call_id: 't', tool_name: 'x' });
    agent.text('Done.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls.at(-1)).toBe('end gen_1');
    expect(floors().at(-1)).toBe('agent_speaking');
    conversation.speechState('gen_1', 'finished');
    expect(speech.calls.slice(-3)).toEqual(['begin gen_2', 'append gen_2 Done.', 'end gen_2']);
    expect(floors().at(-1)).not.toBe('listening');
    conversation.speechState('gen_2', 'finished');
    expect(floors().at(-1)).toBe('listening');
  });

  it('caller speech while the ended preamble is still playing is a barge-in', async () => {
    const { speech, conversation, agent, logger } = await speaking();
    agent.push({ type: 'tool.start', tool_call_id: 't', tool_name: 'x' });
    await flushMicrotasks();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
    expect(logger.names()).toContain('barge_in');
    conversation.userSpeechDiscarded();
    agent.text('More.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
  });
});

describe('ConversationController held speech edge cases (verifier)', () => {
  async function held() {
    const ctx = setup();
    ctx.conversation.userTurn('check the weather');
    await flushMicrotasks();
    ctx.conversation.userSpeechStarted();
    const agent = ctx.adapter.channels[0]!;
    agent.text('It is sunny ');
    await flushMicrotasks();
    expect(ctx.speech.calls).toEqual([]);
    return { ...ctx, agent };
  }

  it('an agent error while text is held: notice now, the held part plays after the noise', async () => {
    const { speech, conversation, agent, floors, of } = await held();
    agent.push({ type: 'error', code: 'boom', retryable: false });
    await flushMicrotasks();
    expect(of('notice').map((n) => n.code)).toEqual(['agent_failed']);
    expect(agent.signal.aborted).toBe(true);
    expect(floors().at(-1)).toBe('user_speaking');
    conversation.userSpeechDiscarded();
    expect(speech.calls).toEqual(['begin gen_1', 'append gen_1 It is sunny ', 'end gen_1']);
    conversation.speechState('gen_1', 'finished');
    expect(floors().at(-1)).toBe('listening');
  });

  it('an agent timeout while text is held, then a committed turn: held text dropped, no cancel', async () => {
    const { speech, conversation, scheduler, of, adapter } = await held();
    scheduler.advance(AGENT_TIMEOUTS.idleMs);
    await flushMicrotasks();
    expect(of('notice').map((n) => n.code)).toEqual(['agent_timeout']);
    conversation.userTurn('hello?');
    await flushMicrotasks();
    expect(speech.calls).toEqual([]);
    // Already given up on by the timeout: not cancelled a second time.
    expect(adapter.cancelled).toEqual([]);
    adapter.channels[1]!.text('Hi.');
    adapter.channels[1]!.done();
    await flushMicrotasks();
    expect(speech.calls).toEqual(['begin gen_1', 'append gen_1 Hi.', 'end gen_1']);
  });

  it('closing the call with text held speaks nothing and leaves no timers', async () => {
    const { speech, conversation, agent, scheduler } = await held();
    conversation.close();
    conversation.userSpeechDiscarded();
    await flushMicrotasks();
    expect(speech.calls).toEqual([]);
    expect(agent.signal.aborted).toBe(true);
    expect(scheduler.pending).toBe(0);
  });

  /** The agent is working on turn_1 and the caller is talking again. */
  async function caller() {
    const ctx = setup();
    ctx.conversation.userTurn('check the weather');
    await flushMicrotasks();
    ctx.conversation.userSpeechStarted();
    return { ...ctx, agent: ctx.adapter.channels[0]! };
  }

  // Keep talking (2026-11-12, owner's Hermes calls): the agent answered the first half of a request
  // while the caller paused, the caller went on, and that answer was dropped unheard. It now plays
  // first, then the answer to the rest; nothing is sent to the agent twice.
  it('an answer the agent finished while the caller kept talking plays before the next answer', async () => {
    const { speech, conversation, agent, adapter, logger } = await caller();
    agent.text('It is sunny.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls).toEqual([]);
    conversation.userTurn('and tomorrow?');
    await flushMicrotasks();
    expect(speech.calls).toEqual(['begin gen_1', 'append gen_1 It is sunny. ']);
    expect(
      logger.events.find((e) => e.fields.event === 'unheard_answer_carried')?.fields,
    ).toMatchObject({ from_turn_id: 'turn_1', turn_id: 'turn_2', text_chars: 12 });
    expect(logger.names()).not.toContain('turn_merged');
    expect(adapter.channels[1]?.turn.text).toBe('and tomorrow?');
    const next = adapter.channels[1]!;
    next.text('Rain tomorrow.');
    next.done();
    await flushMicrotasks();
    expect(speech.calls.slice(2)).toEqual([
      'append gen_1 Rain ',
      'append gen_1 tomorrow.',
      'end gen_1',
    ]);
  });

  it('a carried answer still unheard is carried again when the caller goes on before the next answer', async () => {
    const { speech, conversation, agent, logger } = await caller();
    agent.text('It is sunny.');
    agent.done();
    await flushMicrotasks();
    conversation.userTurn('and tomorrow?');
    await flushMicrotasks();
    // Neither played nor answered yet: the caller adds more.
    conversation.userTurn('and on Friday?');
    await flushMicrotasks();
    const carried = logger.events.filter((e) => e.fields.event === 'unheard_answer_carried');
    expect(carried.map((e) => e.fields)).toMatchObject([
      { from_turn_id: 'turn_1', turn_id: 'turn_2', text_chars: 12 },
      { from_turn_id: 'turn_2', turn_id: 'turn_3', text_chars: 12 },
    ]);
    expect(speech.calls.at(-1)).toMatch(/^append gen_\d+ It is sunny\. $/);
  });

  it('a carried answer is not carried again once it has been heard', async () => {
    const { speech, conversation, agent, logger } = await caller();
    agent.text('It is sunny.');
    agent.done();
    await flushMicrotasks();
    conversation.userTurn('and tomorrow?');
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    conversation.userSpeechStarted();
    conversation.userPartial('wait'); // a barge-in on the carried answer
    conversation.userTurn('never mind');
    await flushMicrotasks();
    expect(logger.names().filter((n) => n === 'unheard_answer_carried')).toHaveLength(1);
    expect(speech.calls.filter((c) => c.includes('sunny'))).toHaveLength(1);
  });

  it('a long unheard answer stays in the chat and is not read out', async () => {
    const { speech, conversation, agent, logger } = await caller();
    agent.text(`${'word '.repeat(200)}end.`);
    agent.done();
    await flushMicrotasks();
    conversation.userTurn('and tomorrow?');
    await flushMicrotasks();
    expect(speech.calls).toEqual([]);
    expect(logger.names()).not.toContain('unheard_answer_carried');
  });

  it('a carried answer is the speech-filtered text, not raw markdown', async () => {
    const { speech, conversation, agent } = await caller();
    agent.text('**Sunny** and `warm`.');
    agent.done();
    await flushMicrotasks();
    conversation.userTurn('and tomorrow?');
    await flushMicrotasks();
    const said = speech.calls.filter((c) => c.startsWith('append')).join('|');
    expect(said).toContain('Sunny');
    expect(said).not.toContain('**');
    expect(said).not.toContain('`');
  });

  it('no heard-you tone or progress line plays over a carried answer', async () => {
    const ctx = setup(undefined, undefined, undefined, { presenceCues: true });
    ctx.conversation.userTurn('check the weather');
    await flushMicrotasks();
    ctx.conversation.userSpeechStarted();
    const agent = ctx.adapter.channels[0]!;
    agent.text('It is sunny.');
    agent.done();
    await flushMicrotasks();
    ctx.conversation.userTurn('and tomorrow?');
    await flushMicrotasks();
    ctx.conversation.speechState('gen_1', 'playing');
    ctx.scheduler.advance(30_000);
    expect(ctx.logger.names()).not.toContain('presence_tone');
    expect(ctx.logger.names()).not.toContain('ack_line');
    expect(ctx.speech.calls.filter((c) => c.startsWith('begin'))).toEqual(['begin gen_1']);
    ctx.conversation.close();
  });

  it('the carried answer is echo-protected: hearing it back is not a barge-in', async () => {
    const { speech, conversation, agent, logger, floors } = await caller();
    agent.text('It is sunny today in the city.');
    agent.done();
    await flushMicrotasks();
    conversation.userTurn('and tomorrow?');
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    conversation.userSpeechStarted();
    conversation.userPartial('it is');
    expect(speech.calls).not.toContain('cancel barge_in');
    expect(logger.names()).toContain('echo_rejected');
    expect(floors().at(-1)).toBe('agent_speaking');
  });

  it('the next turn failing while the carried answer plays ends speech and gives the floor back', async () => {
    const { speech, conversation, agent, adapter, floors, scheduler } = await caller();
    agent.text('It is sunny.');
    agent.done();
    await flushMicrotasks();
    conversation.userTurn('and tomorrow?');
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    adapter.channels[1]!.fail(new Error('socket reset'));
    await flushMicrotasks();
    expect(speech.calls).toContain('end gen_1');
    conversation.speechState('gen_1', 'finished');
    await flushMicrotasks();
    expect(floors().at(-1)).toBe('listening');
    conversation.close();
    expect(scheduler.pending).toBe(0);
  });

  // Probe: once the carried answer has finished playing and the agent is still silent on the new
  // turn, the generation stays open, so progressDue sees it as busy for as long as the agent thinks.
  it('a progress line can still play after the carried answer finished and the agent is silent', async () => {
    const ctx = setup(undefined, undefined, undefined, { presenceCues: true });
    ctx.conversation.userTurn('check the weather');
    await flushMicrotasks();
    ctx.conversation.userSpeechStarted();
    const agent = ctx.adapter.channels[0]!;
    agent.text('It is sunny.');
    agent.done();
    await flushMicrotasks();
    ctx.conversation.userTurn('and tomorrow?');
    await flushMicrotasks();
    ctx.conversation.speechState('gen_1', 'playing');
    ctx.conversation.speechState('gen_1', 'finished');
    ctx.scheduler.advance(25_000);
    expect(ctx.logger.names()).toContain('progress_line');
    ctx.conversation.close();
  });

  it('closing the call right after a carry cancels it and leaves no timers', async () => {
    const { speech, conversation, agent, scheduler } = await caller();
    agent.text('It is sunny.');
    agent.done();
    await flushMicrotasks();
    conversation.userTurn('and tomorrow?');
    await flushMicrotasks();
    conversation.close();
    expect(speech.calls.at(-1)).toBe('cancel call_ended');
    expect(scheduler.pending).toBe(0);
  });

  it("a superseded turn's held text never leaks into the next turn's speech", async () => {
    const { speech, conversation, adapter } = await held();
    conversation.userTurn('never mind that one');
    await flushMicrotasks();
    conversation.userSpeechDiscarded(); // a stray discard after the commit
    const next = adapter.channels[1]!;
    next.text('Okay.');
    next.done();
    await flushMicrotasks();
    conversation.userSpeechStarted();
    conversation.userSpeechDiscarded();
    expect(speech.calls.join('|')).not.toContain('sunny');
  });

  it('held text is released in order, before text that arrives after the noise', async () => {
    const { speech, conversation, agent } = await held();
    agent.text('and warm ');
    await flushMicrotasks();
    conversation.userSpeechDiscarded();
    agent.text('today.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls).toEqual([
      'begin gen_1',
      'append gen_1 It is sunny and warm ',
      'append gen_1 today.',
      'end gen_1',
    ]);
  });

  it('caller talks again after a release: that is a barge-in on the released answer', async () => {
    const { speech, conversation, agent, logger } = await held();
    conversation.userSpeechDiscarded();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
    expect(logger.names()).toContain('barge_in');
    agent.text('more.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls.some((c) => c.includes('more'))).toBe(false);
  });

  it('whitespace-only held text does not keep a finished turn open', async () => {
    const ctx = setup();
    ctx.conversation.userTurn('x');
    await flushMicrotasks();
    ctx.conversation.userSpeechStarted();
    ctx.adapter.channels[0]!.text('  \n');
    ctx.adapter.channels[0]!.done();
    await flushMicrotasks();
    ctx.conversation.userSpeechDiscarded();
    expect(ctx.speech.calls).toEqual([]);
    expect(ctx.floors().at(-1)).toBe('listening');
  });
});

/** Deterministic PRNG so a failing fuzz seed can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Speech output that behaves like the pipeline: one live generation, dead once cancelled. */
class StrictSpeech implements SpeechOutput {
  current: string | undefined;
  readonly ended = new Set<string>();
  readonly dead = new Set<string>();
  readonly violations: string[] = [];
  private n = 0;

  constructor(private readonly timeline: string[]) {}

  begin(): string {
    if (this.current !== undefined) this.dead.add(this.current);
    this.n += 1;
    this.current = `gen_${this.n}`;
    this.timeline.push(`begin ${this.current}`);
    return this.current;
  }
  append(id: string, text: string): void {
    if (this.dead.has(id) || id !== this.current) this.violations.push(`append ${id}`);
    if (text === '') this.violations.push('empty append');
  }
  end(id: string): void {
    if (this.dead.has(id) || id !== this.current) this.violations.push(`end ${id}`);
    this.ended.add(id);
  }
  cancel(reason: string): void {
    this.timeline.push(`cancel ${reason}`);
    if (this.current !== undefined) this.dead.add(this.current);
    this.current = undefined;
  }
  callerOnsetAt(): number | undefined {
    return undefined;
  }
  playedMs(): number {
    return 0;
  }
  totalAudioMs(): number | undefined {
    return undefined;
  }
}

describe('ConversationController barge-in fuzz (verifier)', () => {
  for (let seed = 1; seed <= 600; seed += 1) {
    it(`seed ${seed}: no speech from a cut turn, never stuck, no timers left`, async () => {
      const random = mulberry32(seed);
      const timeline: string[] = [];
      const speech = new StrictSpeech(timeline);
      const scheduler = new ManualScheduler();
      const adapter = new ScriptedAdapter();
      const sent: StatusMessage[] = [];
      const logger = {
        info: (fields: Record<string, unknown>) => {
          timeline.push(`log ${String(fields.event)} ${String(fields.turn_id)}`);
        },
        warn: () => undefined,
      };
      const conversation = new ConversationController({
        callId: CALL_ID,
        adapter,
        speech,
        scheduler,
        logger,
        send: (message) => sent.push(message),
      });
      const floors = () => sent.flatMap((m) => (m.type === 'floor' ? [m.floor] : []));
      const agent = () => adapter.channels.at(-1);
      const actions: (() => void)[] = [
        () => conversation.userSpeechStarted(),
        () => conversation.userSpeechDiscarded(),
        () => conversation.userTurn('question'),
        () => conversation.userPartial(random() < 0.5 ? 'word' : 'hold on'),
        () => agent()?.text('word '),
        () => agent()?.text('end. '),
        () =>
          agent()?.push({
            type: 'tool.start',
            tool_call_id: 't',
            tool_name: 'x',
            display_label: 'L',
          }),
        () => agent()?.push({ type: 'tool.end', tool_call_id: 't', status: 'success' }),
        () => agent()?.done(),
        () => agent()?.push({ type: 'error', code: 'e', retryable: false }),
        () => {
          if (speech.current !== undefined) conversation.speechState(speech.current, 'playing');
        },
        () => {
          const id = speech.current;
          if (id !== undefined && speech.ended.has(id)) {
            speech.current = undefined;
            conversation.speechState(id, 'finished');
          }
        },
        () => {
          const id = speech.current;
          if (id !== undefined) {
            speech.dead.add(id);
            speech.current = undefined;
            conversation.speechState(id, 'failed');
          }
        },
        () => scheduler.advance(Math.floor(random() * 40_000)),
      ];
      const steps = 5 + Math.floor(random() * 40);
      for (let i = 0; i < steps; i += 1) {
        actions[Math.floor(random() * actions.length)]!();
        await flushMicrotasks();
      }
      // Quiesce: the caller goes quiet, the agent finishes, whatever is playing plays out.
      for (let i = 0; i < 4; i += 1) {
        conversation.userSpeechDiscarded();
        agent()?.done();
        await flushMicrotasks();
        const id = speech.current;
        if (id !== undefined && speech.ended.has(id)) {
          speech.current = undefined;
          conversation.speechState(id, 'finished');
        }
        scheduler.advance(1000);
        await flushMicrotasks();
      }

      expect(speech.violations).toEqual([]);
      // After a barge-in on a turn, nothing new is spoken until another turn starts.
      let cutTurn: string | undefined;
      for (const entry of timeline) {
        if (entry.startsWith('log barge_in ')) cutTurn = entry.split(' ')[2];
        if (entry.startsWith('log agent_request_started ')) cutTurn = undefined;
        if (entry.startsWith('begin ')) expect(cutTurn, timeline.join('\n')).toBeUndefined();
      }
      if (adapter.channels.length > 0) expect(floors().at(-1)).toBe('listening');
      expect(scheduler.pending).toBe(0);
      // An agent run is only ever aborted by a supersede, a timeout/failure, or close.
      const aborted = adapter.channels.filter((c) => c.signal.aborted).length;
      const superseded = timeline.filter((e) => e.startsWith('log agent_turn_superseded')).length;
      const gaveUp = timeline.filter((e) => e.startsWith('log agent_turn_done')).length;
      expect(aborted).toBeLessThanOrEqual(superseded + gaveUp);
    });
  }
});

describe('ConversationController tool boundaries, second pass (verifier)', () => {
  const tool = (id: string, label?: string) =>
    ({
      type: 'tool.start',
      tool_call_id: id,
      tool_name: 'x',
      ...(label !== undefined && { display_label: label }),
    }) as const;

  // Text held behind a playing preamble crosses a second tool boundary. Released on 'finished', it
  // must go out as a closed generation: the agent is silent in tool b, so an open one is never
  // flushed, keeps the floor on agent_speaking, and a cough in that silence cuts the rest.
  it('text held across a second tool boundary is released as an ended generation', async () => {
    const { speech, conversation, agent, floors, logger } = await speaking();
    agent.push(tool('a', 'Looking…'));
    agent.push({ type: 'tool.end', tool_call_id: 'a', status: 'success' });
    agent.text('Found it, now booking.');
    agent.push(tool('b', 'Booking…'));
    await flushMicrotasks();
    expect(speech.calls.at(-1)).toBe('end gen_1'); // all held behind the preamble
    conversation.speechState('gen_1', 'finished');
    expect(speech.calls.slice(-3)).toEqual([
      'begin gen_2',
      'append gen_2 Found it, now booking.',
      'end gen_2',
    ]);
    conversation.speechState('gen_2', 'playing');
    conversation.speechState('gen_2', 'finished');
    expect(floors().at(-1)).toBe('agent_working(Booking…)');
    conversation.userSpeechStarted(); // a cough during tool b
    conversation.userSpeechDiscarded();
    expect(logger.names()).not.toContain('barge_in');
  });

  it('text held for caller noise across a tool boundary is released as an ended generation', async () => {
    const { speech, conversation, agent, logger } = await speaking();
    agent.push(tool('a'));
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished');
    conversation.userSpeechStarted(); // noise in tool a's silence: only holds
    agent.push({ type: 'tool.end', tool_call_id: 'a', status: 'success' });
    agent.text('Found it, now booking.');
    agent.push(tool('b'));
    await flushMicrotasks();
    conversation.userSpeechDiscarded();
    expect(speech.calls.slice(-3)).toEqual([
      'begin gen_2',
      'append gen_2 Found it, now booking.',
      'end gen_2',
    ]);
    conversation.speechState('gen_2', 'finished');
    conversation.userSpeechStarted(); // another cough, still inside tool b
    expect(logger.names()).not.toContain('barge_in');
  });

  it('repeated tool.start/activity in a row end the generation once and speak nothing extra', async () => {
    const { speech, conversation, agent, floors } = await speaking();
    agent.push(tool('a', 'One…'));
    agent.push({ type: 'activity', label: 'Two…' });
    agent.push(tool('b', 'Three…'));
    await flushMicrotasks();
    expect(speech.calls).toEqual(['begin gen_1', 'append gen_1 Part one ', 'end gen_1']);
    conversation.speechState('gen_1', 'finished');
    expect(floors().at(-1)).toBe('agent_working(Three…)');
    expect(speech.calls).toHaveLength(3);
  });

  it('activity before any text begins nothing', async () => {
    const { speech, conversation, adapter, floors } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    const agent = adapter.channels[0]!;
    agent.push({ type: 'activity', label: 'Thinking…' });
    agent.push(tool('a'));
    await flushMicrotasks();
    expect(speech.calls).toEqual([]);
    expect(floors().at(-1)).toBe('agent_working(Working…)');
    agent.text('Hi.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls).toEqual(['begin gen_1', 'append gen_1 Hi.', 'end gen_1']);
  });

  it('the filter flush at a boundary neither splits nor repeats a word across generations', async () => {
    const { speech, conversation, agent } = await speaking();
    agent.text('Let me look that');
    agent.text(' up.');
    agent.push(tool('a'));
    agent.text('It is ');
    agent.text('here.');
    agent.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished');
    const spoken = (id: string) =>
      speech.calls
        .filter((c) => c.startsWith(`append ${id} `))
        .map((c) => c.slice(`append ${id} `.length))
        .join('');
    expect(spoken('gen_1')).toBe('Part one Let me look that up.');
    expect(spoken('gen_2')).toBe('It is here.');
  });

  it('preamble fails (TTS drop) with text held behind it: the held text is not lost', async () => {
    const { speech, conversation, agent } = await speaking();
    agent.push(tool('a'));
    agent.push({ type: 'tool.end', tool_call_id: 'a', status: 'success' });
    agent.text('The answer ');
    await flushMicrotasks();
    conversation.speechState('gen_1', 'failed');
    agent.text('is four.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls.slice(-4)).toEqual([
      'begin gen_2',
      'append gen_2 The answer is ',
      'append gen_2 four.',
      'end gen_2',
    ]);
  });

  it('preamble fails after the agent finished with text held: held text plays, turn completes once', async () => {
    const { speech, conversation, agent, floors } = await speaking();
    agent.push(tool('a'));
    agent.text('Done.');
    agent.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'failed');
    expect(speech.calls.slice(-3)).toEqual(['begin gen_2', 'append gen_2 Done.', 'end gen_2']);
    conversation.speechState('gen_2', 'finished');
    conversation.speechState('gen_2', 'finished'); // duplicate
    expect(floors().filter((f) => f === 'listening')).toHaveLength(1);
  });

  it('a turn queued while text is held behind a playing preamble: muted, nothing leaks (ADR-026)', async () => {
    const { speech, conversation, agent, adapter } = await speaking();
    agent.push(tool('a'));
    agent.text('Stale answer.');
    await flushMicrotasks();
    conversation.userSpeechStarted(); // barge-in on the still-playing preamble
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    conversation.userTurn('never mind that one');
    await flushMicrotasks();
    // The agent is working with a tool: the new words wait for its turn to end.
    expect(adapter.channels).toHaveLength(1);
    agent.done();
    await flushMicrotasks();
    expect(adapter.channels[1]!.turn.text).toBe('never mind that one');
    conversation.speechState('gen_1', 'finished'); // late
    adapter.channels[1]!.text('Okay.');
    adapter.channels[1]!.done();
    await flushMicrotasks();
    expect(speech.calls.join('|')).not.toContain('Stale');
    expect(speech.calls.filter((c) => c.startsWith('cancel'))).toEqual(['cancel barge_in']);
  });

  it('timeout while text is held behind a playing preamble: the held text plays, then listening', async () => {
    const { speech, conversation, agent, scheduler, floors, of } = await speaking();
    agent.push(tool('a'));
    agent.text('Partial.');
    await flushMicrotasks();
    scheduler.advance(AGENT_TIMEOUTS.idleMs);
    await flushMicrotasks();
    expect(of('notice').map((n) => n.code)).toEqual(['agent_timeout']);
    conversation.speechState('gen_1', 'finished');
    expect(speech.calls.slice(-3)).toEqual(['begin gen_2', 'append gen_2 Partial.', 'end gen_2']);
    conversation.speechState('gen_2', 'finished');
    expect(floors().at(-1)).toBe('listening');
    expect(scheduler.pending).toBe(0);
  });
});

describe('ConversationController released text across a boundary, consequence (verifier)', () => {
  it('a cough during the second tool call does not mute the final answer', async () => {
    const { speech, conversation, agent, floors } = await speaking();
    agent.push({ type: 'tool.start', tool_call_id: 'a', tool_name: 'x' });
    agent.push({ type: 'tool.end', tool_call_id: 'a', status: 'success' });
    agent.text('Found it, now booking.');
    agent.push({
      type: 'tool.start',
      tool_call_id: 'b',
      tool_name: 'x',
      display_label: 'Booking…',
    });
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished');
    conversation.speechState('gen_2', 'playing');
    // The words held across tool b's boundary are a closed generation, so they finish playing and
    // tool b then runs in silence. (A cough while gen_2 is still audible would rightly cut it.)
    expect(speech.calls).toContain('end gen_2');
    conversation.speechState('gen_2', 'finished');
    expect(floors().at(-1)).toBe('agent_working(Booking…)');
    conversation.userSpeechStarted(); // a cough in the silence
    conversation.userSpeechDiscarded();
    agent.push({ type: 'tool.end', tool_call_id: 'b', status: 'success' });
    agent.text('You are booked.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls.some((c) => c.includes('booked'))).toBe(true);
  });
});

describe('ConversationController heldBoundary lifetime, third pass (verifier)', () => {
  const tool = (id: string) => ({ type: 'tool.start', tool_call_id: id, tool_name: 'x' }) as const;
  const toolEnd = (id: string) =>
    ({ type: 'tool.end', tool_call_id: id, status: 'success' }) as const;

  // heldBoundary is set when text held behind an ended preamble crosses a second boundary. If that
  // preamble then FAILS (TTS drop) rather than finishing, nothing consumes the flag: the agent's next
  // text drains the held text into a fresh open generation without clearing it. The stale flag then
  // fires on the next unrelated release, ending that generation at once, so the rest of the same
  // sentence is held behind it and spoken as yet another generation (an audible gap mid-answer).
  it('a boundary consumed by a TTS failure does not end a later, unrelated released generation', async () => {
    const { speech, conversation, agent } = await speaking();
    agent.push(tool('a'));
    agent.push(toolEnd('a'));
    agent.text('Held one. ');
    agent.push({ type: 'activity', label: 'Thinking…' }); // boundary while held behind gen_1
    await flushMicrotasks();
    conversation.speechState('gen_1', 'failed'); // TTS dropped: nothing released yet
    agent.text('Resumed. ');
    await flushMicrotasks();
    expect(speech.calls.slice(-2)).toEqual(['begin gen_2', 'append gen_2 Held one. Resumed. ']);
    agent.push(tool('b'));
    agent.push(toolEnd('b'));
    agent.text('After b ');
    await flushMicrotasks();
    expect(speech.calls.at(-1)).toBe('end gen_2'); // 'After b ' is held behind gen_2
    conversation.speechState('gen_2', 'playing');
    conversation.speechState('gen_2', 'finished');
    expect(speech.calls.slice(-2)).toEqual(['begin gen_3', 'append gen_3 After b ']);
    agent.text('continues.');
    agent.done();
    await flushMicrotasks();
    // One generation for the whole post-tool sentence, as without the failure.
    expect(speech.calls.slice(-2)).toEqual(['append gen_3 continues.', 'end gen_3']);
  });

  it('a boundary held after a failed preamble is honoured by the release on caller noise', async () => {
    const { speech, conversation, agent } = await speaking();
    agent.push(tool('a'));
    agent.push(toolEnd('a'));
    agent.text('Held one. ');
    agent.push(tool('b'));
    await flushMicrotasks();
    conversation.speechState('gen_1', 'failed');
    conversation.userSpeechStarted(); // nothing audible: only holds
    conversation.userSpeechDiscarded();
    expect(speech.calls.slice(-3)).toEqual(['begin gen_2', 'append gen_2 Held one. ', 'end gen_2']);
  });

  it('boundary held while the caller talks, agent done meanwhile: released once, ended, turn completes', async () => {
    const { speech, conversation, agent, floors, scheduler } = await speaking();
    agent.push(tool('a'));
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished');
    conversation.userSpeechStarted(); // noise in the silence
    agent.push(toolEnd('a'));
    agent.text('Booked it. ');
    agent.push(tool('b'));
    agent.push(toolEnd('b'));
    agent.text('All set.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls.at(-1)).toBe('end gen_1');
    conversation.userSpeechDiscarded();
    expect(speech.calls.slice(-3)).toEqual([
      'begin gen_2',
      'append gen_2 Booked it. All set.',
      'end gen_2',
    ]);
    conversation.speechState('gen_2', 'playing');
    conversation.speechState('gen_2', 'finished');
    expect(floors().at(-1)).toBe('listening');
    expect(speech.calls.filter((c) => c.startsWith('begin'))).toHaveLength(2);
    expect(scheduler.pending).toBe(0);
  });

  it('a barge-in on a released-and-ended generation drops the rest; the queued turn then starts clean', async () => {
    const { speech, conversation, agent, adapter } = await speaking();
    agent.push(tool('a'));
    agent.push(toolEnd('a'));
    agent.text('Found it. ');
    agent.push(tool('b'));
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished'); // released as ended gen_2
    conversation.speechState('gen_2', 'playing');
    conversation.userSpeechStarted(); // barge-in on gen_2
    conversation.userPartial('hold on'); // not echo: confirms the barge-in
    agent.push(toolEnd('b'));
    agent.text('Stale rest.');
    await flushMicrotasks();
    conversation.userTurn('a new question please');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1); // queued behind the working turn (ADR-026)
    agent.done();
    await flushMicrotasks();
    const next = adapter.channels[1]!;
    next.text('Fresh.');
    next.push(tool('c'));
    await flushMicrotasks();
    expect(speech.calls.join('|')).not.toContain('Stale');
    expect(speech.calls.slice(-3)).toEqual(['begin gen_3', 'append gen_3 Fresh.', 'end gen_3']);
    conversation.speechState('gen_3', 'finished');
    next.text('More.');
    next.done();
    await flushMicrotasks();
    // Open generation after a clean release: 'More.' is not force-ended by a leftover flag.
    expect(speech.calls.slice(-3)).toEqual(['begin gen_4', 'append gen_4 More.', 'end gen_4']);
  });
});

describe('ConversationController echo rejection (ADR-015)', () => {
  it('an echo partial during agent speech does not cut it; a non-echo partial does', async () => {
    const { speech, conversation, floors, logger, scheduler } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('part one');
    conversation.userPartial('Part');
    expect(speech.calls).not.toContain('cancel barge_in');
    expect(floors().at(-1)).toBe('agent_speaking');
    expect(logger.names().filter((n) => n === 'echo_rejected')).toHaveLength(1);
    expect(logger.events.find((e) => e.fields.event === 'echo_rejected')?.fields).toEqual({
      event: 'echo_rejected',
      call_id: CALL_ID,
      phase: 'partial',
      words: 2,
      overlap: 1,
    });
    scheduler.advance(120);
    conversation.userPartial('part one wait');
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
    expect(floors().at(-1)).toBe('user_speaking');
    expect(logger.events.find((e) => e.fields.event === 'barge_in')?.fields).toMatchObject({
      confirm_ms: 120,
    });
  });

  it('one new word among echo words is enough to cut', async () => {
    const { speech, conversation } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('one stop');
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
  });

  it('an echo commit is dropped: agent not called again, answer continues, floor stays on the agent', async () => {
    const { adapter, speech, conversation, floors, agent, logger } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('part');
    conversation.userTurn('Part one');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(agent.signal.aborted).toBe(false);
    expect(logger.names()).not.toContain('agent_turn_superseded');
    expect(logger.names()).not.toContain('barge_in');
    expect(logger.events.find((e) => e.fields.phase === 'commit')?.fields).toEqual({
      event: 'echo_rejected',
      call_id: CALL_ID,
      phase: 'commit',
      words: 2,
      overlap: 1,
    });
    expect(floors().at(-1)).toBe('agent_speaking');
    agent.text('and part two.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls.slice(-3)).toEqual([
      'append gen_1 and part ',
      'append gen_1 two.',
      'end gen_1',
    ]);
    expect(speech.calls.filter((c) => c.startsWith('cancel'))).toEqual([]);
  });

  it('a genuine commit during speech still supersedes', async () => {
    const { adapter, speech, conversation, agent, logger } = await speaking();
    conversation.userSpeechStarted();
    conversation.userTurn('what time is it');
    await flushMicrotasks();
    expect(speech.calls).toContain('cancel barge_in');
    expect(agent.signal.aborted).toBe(true);
    expect(logger.names()).toContain('agent_turn_superseded');
    expect(adapter.channels).toHaveLength(2);
  });

  it('speech started then discarded with only echo partials leaves the answer untouched', async () => {
    const { speech, conversation, floors, agent } = await speaking();
    const floorsBefore = floors();
    conversation.userSpeechStarted();
    conversation.userPartial('one');
    conversation.userSpeechDiscarded();
    expect(floors()).toEqual(floorsBefore);
    agent.text('More.');
    agent.done();
    await flushMicrotasks();
    expect(speech.calls).toEqual([
      'begin gen_1',
      'append gen_1 Part one ',
      'append gen_1 More.',
      'end gen_1',
    ]);
    conversation.speechState('gen_1', 'finished');
    expect(floors().at(-1)).toBe('listening');
  });

  it('echo of a finished answer is dropped for ECHO_FINISHED_TAIL_MS, then treated as the caller', async () => {
    const { adapter, conversation, scheduler, logger } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    adapter.channels[0]!.text('Hello there.');
    adapter.channels[0]!.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished');
    scheduler.advance(ECHO_FINISHED_TAIL_MS - 1);
    conversation.userSpeechStarted();
    conversation.userTurn('hello there');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(logger.names()).toContain('echo_rejected');
    scheduler.advance(1);
    conversation.userSpeechStarted();
    conversation.userTurn('hello there');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
  });

  it('a committed echo never supersedes a working turn', async () => {
    const { adapter, speech, conversation, agent, floors } = await speaking();
    agent.push({ type: 'tool.start', tool_call_id: 't', tool_name: 'x' });
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished'); // silent tool call: no generation
    conversation.userSpeechStarted(); // holds, caller has the floor
    expect(floors().at(-1)).toBe('user_speaking');
    agent.push({ type: 'tool.end', tool_call_id: 't', status: 'success' });
    agent.text('Found it.');
    await flushMicrotasks();
    conversation.userTurn('part one');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(agent.signal.aborted).toBe(false);
    // Released as if it were noise.
    expect(speech.calls.slice(-2)).toEqual(['begin gen_2', 'append gen_2 Found ']);
  });

  it('echo logs never carry transcript text', async () => {
    const { conversation, logger } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('part one');
    conversation.userTurn('part one');
    await flushMicrotasks();
    expect(logger.names()).toContain('echo_rejected');
    expect(JSON.stringify(logger.events)).not.toMatch(/part one/i);
  });
});

/** An answer whose text is all sent to TTS at once; the caller is heard while gen_1 plays. */
async function answering(text: string) {
  const ctx = setup();
  ctx.conversation.userTurn('which one');
  await flushMicrotasks();
  const agent = ctx.adapter.channels[0]!;
  agent.text(text);
  await flushMicrotasks();
  ctx.conversation.speechState('gen_1', 'playing');
  return { ...ctx, agent };
}

describe('ConversationController echo rejection, attack pass (verifier)', () => {
  // BUG: once a partial has proved the caller is not echo (barge-in confirmed, answer muted), the
  // commit is judged again from scratch. Filler + the agent's words reaches 60% pairs, so the
  // caller's turn is dropped as echo: the answer is already cut and never resumes -> dead air.
  it('a commit after a confirmed barge-in is not dropped as echo', async () => {
    const { adapter, speech, conversation, floors } = await answering(
      'Option one is the red one. Option two is the blue one. ',
    );
    conversation.userSpeechStarted();
    conversation.userPartial('um'); // not echo: barge-in confirmed, speech cut for good
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
    conversation.userTurn('um the blue one'); // "um the" new; "the blue", "blue one" agent's: 2/3
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    expect(floors().at(-1)).toBe('agent_working');
  });

  // BUG: a caller's short interruption appended to an echo transcript is swallowed. On the loud
  // speakerphone this feature targets, Flux keeps one turn open over the echo, so the caller's
  // "stop" lands at the end of an agent-worded transcript: pairs stay >= 60% agent's, the barge-in
  // is never confirmed, and the commit is dropped with the caller's word in it.
  it('the caller saying stop after an echo run is heard', async () => {
    const { adapter, speech, conversation } = await answering(
      'Option one is the red one. Option two is the blue one. ',
    );
    conversation.userSpeechStarted();
    conversation.userPartial('option one is'); // echo: pending, fine
    conversation.userPartial('option one is the red one stop'); // 5/6 pairs agent's
    expect(speech.calls).toContain('cancel barge_in');
    conversation.userTurn('option one is the red one stop');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
  });

  // BUG: a short answer to the agent's own question, given within 5 s (the old ECHO_MEMORY_MS) after the question
  // finished playing, is dropped as echo: nothing happens and the call looks dead. The caller's
  // speech started after the agent had gone silent, so it cannot be residual echo.
  it('answering the agent choice question with one of its words is not echo', async () => {
    const { adapter, conversation, scheduler, floors } = await answering(
      'Would you like the red one or the blue one?',
    );
    adapter.channels[0]!.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished');
    expect(floors().at(-1)).toBe('listening');
    scheduler.advance(1500); // the caller thinks, then answers
    conversation.userSpeechStarted();
    conversation.userPartial('the blue');
    scheduler.advance(400);
    conversation.userTurn('The blue one.');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
  });

  // Was RISK (turn-wide echo memory). Now: 30 s into a silent tool call nothing is audible, so the
  // caller repeating two of the preamble's words is heard.
  it('words heard 30 s ago during a silent tool call are not echo', async () => {
    const { adapter, conversation, scheduler, agent, logger } = await answering(
      'Let me check the weather in Paris. ',
    );
    agent.push({ type: 'tool.start', tool_call_id: 't', tool_name: 'weather' });
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished');
    scheduler.advance(30_000);
    conversation.userSpeechStarted();
    conversation.userTurn('in Paris?');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    expect(logger.names()).not.toContain('echo_rejected');
  });

  // Was RISK (text TTS had not played yet counted as echo). Now only the window around the playout
  // position counts: a word from the last sentence, said ~1 s into playout, is the caller.
  it('words the agent has not spoken yet (TTS ahead of playout) are not echo', async () => {
    const { speech, conversation } = await answering(
      'Once upon a time there was a fox. And so on. I could go on, or stop here if you like. ',
    );
    speech.played.set('gen_1', 1000);
    conversation.userSpeechStarted();
    conversation.userPartial('stop'); // said ~1 s into playout; "stop" is only in the last sentence
    expect(speech.calls).toContain('cancel barge_in');
  });

  // RISK (pins current behavior): echo that STT mishears by one word confirms a barge-in (false cut).
  it('RISK: one misheard word in a short echo partial cuts the answer', async () => {
    const { speech, conversation } = await answering("It's sunny in Paris today. ");
    conversation.userSpeechStarted();
    conversation.userPartial('sunny in parish');
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
  });

  it('two speech starts without a partial open one pending barge-in; one confirm cuts once', async () => {
    const { speech, conversation, logger, scheduler } = await answering('Part one ');
    conversation.userSpeechStarted();
    scheduler.advance(50);
    conversation.userSpeechStarted();
    scheduler.advance(50);
    conversation.userPartial('hold on');
    conversation.userPartial('hold on please');
    expect(speech.calls.filter((c) => c === 'cancel barge_in')).toHaveLength(1);
    expect(logger.events.find((e) => e.fields.event === 'barge_in')?.fields).toMatchObject({
      confirm_ms: 100,
    });
  });

  it('a partial with no pending barge-in changes nothing', async () => {
    const { speech, conversation, floors, sent } = await answering('Part one ');
    const before = sent.length;
    conversation.userPartial('hold on');
    expect(speech.calls).not.toContain('cancel barge_in');
    expect(sent).toHaveLength(before);
    expect(floors().at(-1)).toBe('agent_speaking');
  });

  it('pending barge-in outliving the turn: floor listening until confirmed, then user_speaking', async () => {
    const { adapter, speech, conversation, floors, agent } = await answering('Part one ');
    conversation.userSpeechStarted();
    conversation.userPartial('part'); // echo: pending
    agent.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished'); // turn complete while pending
    expect(floors().at(-1)).toBe('listening');
    conversation.userPartial('part one what'); // "one what" new: 1/2
    expect(floors().at(-1)).toBe('user_speaking');
    expect(speech.calls).not.toContain('cancel barge_in'); // nothing left to cut
    conversation.userTurn('part one what about part two');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    expect(floors().at(-1)).toBe('agent_working');
  });

  it('pending barge-in cleared by an echo commit: the next start opens a fresh one', async () => {
    const { speech, conversation, logger, scheduler } = await answering('Part one ');
    conversation.userSpeechStarted();
    conversation.userTurn('part one'); // echo, dropped; pending cleared
    scheduler.advance(1000);
    conversation.userSpeechStarted();
    scheduler.advance(30);
    conversation.userPartial('hold on');
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
    expect(logger.events.find((e) => e.fields.event === 'barge_in')?.fields).toMatchObject({
      confirm_ms: 30,
    });
  });

  it('close with a pending barge-in: later partials and commits do nothing', async () => {
    const { adapter, speech, conversation, sent } = await answering('Part one ');
    conversation.userSpeechStarted();
    conversation.close();
    const before = sent.length;
    conversation.userPartial('hold on');
    conversation.userTurn('hold on');
    conversation.userSpeechDiscarded();
    await flushMicrotasks();
    expect(speech.calls.filter((c) => c === 'cancel barge_in')).toEqual([]);
    expect(adapter.channels).toHaveLength(1);
    expect(sent).toHaveLength(before);
  });

  it('echo commit while text is held behind a playing preamble: released after it finishes', async () => {
    const { speech, conversation, agent, floors } = await answering('One moment. ');
    agent.push({ type: 'tool.start', tool_call_id: 't', tool_name: 'x' });
    await flushMicrotasks();
    agent.push({ type: 'tool.end', tool_call_id: 't', status: 'success' });
    agent.text('Found it. ');
    await flushMicrotasks();
    conversation.userSpeechStarted(); // over the playing preamble: pending
    conversation.userTurn('one moment'); // echo: dropped, pending cleared
    expect(floors().at(-1)).toBe('agent_speaking');
    conversation.speechState('gen_1', 'finished');
    expect(speech.calls.slice(-3)).toEqual(['end gen_1', 'begin gen_2', 'append gen_2 Found it. ']);
  });

  it('echo memory is pruned: old turns do not accumulate', async () => {
    const { adapter, conversation, scheduler } = setup();
    for (let i = 0; i < 50; i += 1) {
      conversation.userTurn(`question ${i}`);
      await flushMicrotasks();
      adapter.channels[i]!.text(`Answer number ${i}.`);
      adapter.channels[i]!.done();
      await flushMicrotasks();
      conversation.speechState(`gen_${i + 1}`, 'finished');
      scheduler.advance(ECHO_TAIL_MS);
    }
    const internal = conversation as unknown as { generations: unknown[] };
    expect(internal.generations.length).toBeLessThanOrEqual(1);
  });

  it('echo rejection logs carry counts only, never text, across partial and commit', async () => {
    const { conversation, logger, speech } = await answering('Secret plan alpha bravo. ');
    speech.played.set('gen_1', 1000);
    conversation.userSpeechStarted();
    conversation.userPartial('secret plan');
    conversation.userPartial('secret plan alpha');
    conversation.userTurn('secret plan alpha bravo');
    await flushMicrotasks();
    const echoLogs = logger.events.filter((e) => e.fields.event === 'echo_rejected');
    expect(echoLogs).toHaveLength(2); // one for the partials, one for the commit
    for (const e of echoLogs) {
      expect(Object.keys(e.fields).sort()).toEqual([
        'call_id',
        'event',
        'overlap',
        'phase',
        'words',
      ]);
    }
    expect(JSON.stringify(logger.events)).not.toMatch(/secret|alpha|bravo/i);
  });
});

// Final pass on the audible-window rule (ADR-015 v2). "BUG:" tests assert the intended behaviour and
// fail today; "RISK:" tests pin current behaviour so the trade-off is visible.
describe('ConversationController echo window v2, final pass (verifier)', () => {
  /** Words of `text` whose first character lies in [fromChar, toChar). */
  const slice = (text: string, fromChar: number, toChar: number) =>
    [...text.matchAll(/\S+/g)]
      .filter((m) => m.index >= fromChar && m.index < toChar)
      .map((m) => m[0])
      .join(' ');

  // BUG: on the loud speakerphone ADR-015 targets, Flux keeps one turn open over continuous echo and
  // commits it at a pause. Each partial's tail is echo (pending stays pending), but the commit is
  // judged by echoPrefixLength against ONE run, and each run is a single ~5-8 s window snapshot.
  // An echo commit longer than one window is never covered, so it commits: the answer is cut and
  // the agent is sent its own words as the caller's turn.
  it('BUG: a long echo commit (one sentence, ~8 s) is dropped like a short one', async () => {
    const text =
      'Once upon a time there was a little fox who lived at the edge of a quiet forest near a ' +
      'wide river, and every morning she walked down to the water and watched the fishing boats ' +
      'drift slowly past the old stone bridge. ';
    const cps = 15;
    const { adapter, speech, conversation, scheduler, logger } = await answering(text);
    speech.totals.set('gen_1', (text.length / cps) * 1000); // TTS already done: rate known
    const at = (ms: number) => Math.floor((ms * cps) / 1000);
    const tick = (ms: number) => {
      scheduler.advance(ms);
      speech.played.set('gen_1', scheduler.now());
    };
    tick(1500);
    conversation.userSpeechStarted(); // echo of what played from ~1 s
    while (scheduler.now() < 9500) {
      tick(500);
      // STT lags the heard audio (queue + network + recognition) by ~600 ms.
      conversation.userPartial(slice(text, at(1000), at(scheduler.now() - 600)));
    }
    expect(speech.calls).not.toContain('cancel barge_in'); // every tail was echo
    tick(500);
    conversation.userTurn(slice(text, at(1000), at(scheduler.now() - 600)));
    await flushMicrotasks();
    expect(logger.names()).not.toContain('agent_turn_superseded');
    expect(speech.calls).not.toContain('cancel barge_in');
    expect(adapter.channels).toHaveLength(1);
  });

  it('a short echo commit (within one window) is dropped', async () => {
    const text =
      'Once upon a time there was a little fox who lived at the edge of a quiet forest near a ' +
      'wide river, and every morning she walked down to the water. ';
    const { adapter, speech, conversation, scheduler } = await answering(text);
    speech.totals.set('gen_1', (text.length / 15) * 1000);
    scheduler.advance(3000);
    speech.played.set('gen_1', 3000);
    conversation.userSpeechStarted();
    conversation.userPartial('upon a time there');
    conversation.userTurn('upon a time there was a little fox');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(speech.calls).not.toContain('cancel barge_in');
  });

  // BUG: the ECHO_TAIL_MS clock starts when the last frame is handed to LiveKit. The phone plays it
  // ~200 ms (AudioSource queue) + network/jitter later, and Flux reports StartOfTurn a few hundred
  // ms after the caller's onset. A caller answering the agent's closing question promptly (a normal
  // ~300 ms human gap) therefore gets speech-start inside the tail, and a reply made of the
  // question's words ("the blue one") is dropped as echo: dead air, the caller has to repeat.
  it('BUG: a prompt answer to the closing choice question is not dropped as echo', async () => {
    const { adapter, conversation, scheduler, floors } = await answering(
      'Would you like the red one or the blue one?',
    );
    adapter.channels[0]!.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished');
    expect(floors().at(-1)).toBe('listening');
    scheduler.advance(800); // ~250 ms queue + ~100 ms network + ~250 ms human gap + ~200 ms Flux
    conversation.userSpeechStarted();
    conversation.userPartial('the blue');
    scheduler.advance(400);
    conversation.userTurn('The blue one.');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
  });

  // Was RISK (1 s tail after a played-out answer). The finished tail is now ECHO_FINISHED_TAIL_MS.
  it("a one-word answer from the question after the finished tail is the caller's", async () => {
    const { adapter, conversation, scheduler, logger } = await answering(
      'Should I send it now, or later tonight?',
    );
    adapter.channels[0]!.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished');
    scheduler.advance(700);
    conversation.userSpeechStarted();
    conversation.userTurn('Now.');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    expect(logger.names()).not.toContain('echo_rejected');
  });

  // BUG (normaliser): "3-5" joins single-character hyphen parts into "35" -> "thirty five". TTS says
  // "three to five", so neither "three" nor "to" is in the window and residual echo of any digit
  // range ("2-3 days", "5-10 minutes") confirms a false barge-in.
  it('BUG: echo of a digit range ("3-5 business days") does not cut the answer', async () => {
    const { speech, conversation } = await answering('Delivery takes 3-5 business days. ');
    speech.played.set('gen_1', 1500);
    conversation.userSpeechStarted();
    conversation.userPartial('delivery takes three to five');
    expect(speech.calls).not.toContain('cancel barge_in');
    conversation.userPartial('delivery takes 3 to 5 business days');
    expect(speech.calls).not.toContain('cancel barge_in');
  });

  // RISK (normaliser): "its" and "it's" are homophones; STT picks either. The agent's "it's" is
  // "it is" in the window, so an STT "its" (or vice versa) is a word not in the window.
  it('RISK: echo of "it\'s" transcribed as "its" cuts the answer', async () => {
    const { speech, conversation } = await answering("It's ready now. ");
    conversation.userSpeechStarted();
    conversation.userPartial('its ready');
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
  });

  // RISK: until TTS reports the total, the position runs at 14 chars/s. A voice at ~17 chars/s
  // (~175 wpm) outruns the +15% slack after ~35 s, and echo of the words heard now is outside the
  // window. Only when the generation stays open that long (slow-streaming agent, no tool boundary).
  it('RISK: before totalAudioMs is known, a faster voice drifts out of the window on long answers', async () => {
    const words = Array.from({ length: 400 }, (_, i) => `w${i}x`); // unique 4-5 char words
    const text = `${words.join(' ')} `;
    const { speech, conversation } = await answering(text);
    const playedMs = 45_000;
    speech.played.set('gen_1', playedMs);
    const heardChar = Math.floor(((playedMs - 600) * 17) / 1000);
    const heard = slice(text, heardChar - 20, heardChar);
    conversation.userSpeechStarted();
    conversation.userPartial(heard);
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
    // ...the same audio with the rate known is echo.
    const again = await answering(text);
    again.speech.played.set('gen_1', playedMs);
    again.speech.totals.set('gen_1', (text.length / 17) * 1000);
    again.conversation.userSpeechStarted();
    again.conversation.userPartial(heard);
    expect(again.speech.calls).not.toContain('cancel barge_in');
  });

  // RISK: partials usually add 1-2 words, and tails under 3 words are judged on word membership
  // only. The ordered-pair check therefore rarely runs: a real phrase made only of words in the
  // window never confirms the barge-in; the answer plays over the caller until their commit.
  it('RISK: a real phrase of window words, arriving word by word, never confirms the barge-in', async () => {
    const text = 'I can send it to you by email, or you can pick it up. ';
    const whole = await answering(text);
    whole.speech.played.set('gen_1', 2000); // "I can send it to you by email, or you can" audible
    whole.conversation.userSpeechStarted();
    whole.conversation.userPartial('can you send it');
    expect(whole.speech.calls.at(-1)).toBe('cancel barge_in'); // 1/3 pairs: real

    const { adapter, speech, conversation } = await answering(text);
    speech.played.set('gen_1', 2000);
    conversation.userSpeechStarted();
    for (const partial of ['can', 'can you', 'can you send', 'can you send it'])
      conversation.userPartial(partial);
    expect(speech.calls).not.toContain('cancel barge_in');
    conversation.userTurn('can you send it'); // not in order: commits, supersedes
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
  });

  // Once real, always real: a later echo-only partial or commit never un-confirms the utterance.
  it('a real utterance stays real through later echo partials and an echo-like commit', async () => {
    const { adapter, speech, conversation } = await answering('Part one of the story. ');
    conversation.userSpeechStarted();
    conversation.userPartial('hmm');
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
    conversation.userPartial('part one of');
    conversation.userTurn('part one of');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
  });

  // Per-utterance state does not leak: after an echo commit, the next utterance starts fresh.
  it('a new utterance after an echo commit is judged afresh (no lastWords or real flag carried)', async () => {
    const { speech, conversation } = await answering('Part two of the story. ');
    conversation.userSpeechStarted();
    conversation.userTurn('part two'); // echo: dropped
    await flushMicrotasks();
    conversation.userSpeechStarted();
    conversation.userPartial('part two of'); // judged whole, not as the tail "of"
    expect(speech.calls).not.toContain('cancel barge_in');
    conversation.userPartial('part two of wow');
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
  });

  // Flux revising an earlier word: the whole partial is judged again, so an echo run revised to
  // another echo run stays echo, and a revision that brings in a non-window word confirms.
  it('a Flux revision re-judges the whole partial', async () => {
    const { speech, conversation } = await answering('It is sunny in Paris today. ');
    speech.played.set('gen_1', 1000);
    conversation.userSpeechStarted();
    conversation.userPartial('it is sunny');
    conversation.userPartial('it is sunny in paris');
    conversation.userPartial('is sunny in paris today'); // revised (dropped first word): echo
    expect(speech.calls).not.toContain('cancel barge_in');
    conversation.userPartial('it is funny in paris today'); // revised with a non-window word
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
  });

  // After a cut the generation keeps its window at the frozen position for ECHO_TAIL_MS.
  it('after a cut, echo of the words at the cut is rejected for ECHO_TAIL_MS only', async () => {
    const text = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima. ';
    const { adapter, speech, conversation, scheduler } = await answering(text);
    speech.played.set('gen_1', 2000);
    conversation.userSpeechStarted();
    conversation.userTurn('what was that'); // commits: cut (superseded)
    await flushMicrotasks();
    expect(speech.calls).toContain('cancel barge_in');
    scheduler.advance(ECHO_TAIL_MS - 1);
    conversation.userSpeechStarted();
    conversation.userTurn('bravo charlie delta'); // residual echo of the cut: dropped
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    scheduler.advance(1);
    conversation.userSpeechStarted();
    conversation.userTurn('bravo charlie delta');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(3);
  });

  // Two generations in one turn: the preamble's tail and the answer's window are both audible.
  it('across a tool boundary: preamble tail and the new generation both count, then the tail expires', async () => {
    const { speech, conversation, agent, scheduler } = await answering('Let me check that. ');
    agent.push({ type: 'tool.start', tool_call_id: 't', tool_name: 'x' });
    await flushMicrotasks();
    agent.push({ type: 'tool.end', tool_call_id: 't', status: 'success' });
    agent.text('The meeting is at noon. ');
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished');
    conversation.speechState('gen_2', 'playing');
    scheduler.advance(300);
    conversation.userSpeechStarted();
    conversation.userPartial('check that'); // preamble tail
    conversation.userPartial('check that the meeting'); // new generation
    expect(speech.calls).not.toContain('cancel barge_in');
    conversation.userSpeechDiscarded();
    scheduler.advance(ECHO_TAIL_MS);
    conversation.userSpeechStarted();
    conversation.userPartial('check that'); // preamble no longer audible
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
  });
});

describe('ConversationController keep talking (merged unanswered turns)', () => {
  const note = '[Your last reply was cut off because I kept talking. Here is my full request:]';

  it('a turn superseded before any of its speech played is merged into the next', async () => {
    const { adapter, conversation, logger, sent } = setup();
    conversation.userTurn('book a table for two');
    await flushMicrotasks();
    adapter.channels[0]!.text('Sure, ');
    await flushMicrotasks();
    conversation.userTurn('at seven tonight');
    await flushMicrotasks();
    expect(adapter.channels[1]!.turn.text).toBe(`${note} book a table for two at seven tonight`);
    expect(JSON.stringify(sent)).not.toContain(note);
    expect(JSON.stringify(logger.events)).not.toContain(note);
    expect(logger.events.find((e) => e.fields.event === 'turn_merged')?.fields).toEqual({
      event: 'turn_merged',
      call_id: CALL_ID,
      merged_turns: 2,
      text_chars: 37,
    });
    expect(
      logger.events.filter((e) => e.fields.event === 'agent_request_started').at(-1)?.fields,
    ).toMatchObject({ text_chars: 37 });
  });

  it('a turn whose speech was heard is not merged', async () => {
    const { adapter, conversation, logger } = await speaking();
    conversation.userTurn('what time is it');
    await flushMicrotasks();
    expect(adapter.channels[1]!.turn.text).toBe('what time is it');
    expect(logger.names()).not.toContain('turn_merged');
  });

  it('chains three unanswered turns', async () => {
    const { adapter, conversation, logger } = setup();
    conversation.userTurn('A');
    await flushMicrotasks();
    conversation.userTurn('B');
    await flushMicrotasks();
    conversation.userTurn('C');
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['A', `${note} A B`, `${note} A B C`]);
    expect(adapter.channels[2]!.turn.text.split(note)).toHaveLength(2);
    expect(
      logger.events.filter((e) => e.fields.event === 'turn_merged').at(-1)?.fields,
    ).toMatchObject({ merged_turns: 3, text_chars: 5 });
  });

  it('a barged-in turn that had played is not merged', async () => {
    const { adapter, conversation, speech, logger } = await speaking();
    conversation.userSpeechStarted();
    conversation.userPartial('hold on');
    expect(speech.calls.at(-1)).toBe('cancel barge_in');
    conversation.userTurn('hold on, actually cancel that');
    await flushMicrotasks();
    expect(adapter.channels[1]!.turn.text).toBe('hold on, actually cancel that');
    expect(logger.names()).not.toContain('turn_merged');
  });

  it('bounds the merged text, keeping the most recent', async () => {
    const { adapter, conversation, logger } = setup();
    conversation.userTurn('x'.repeat(MAX_MERGED_TURN_CHARS));
    await flushMicrotasks();
    conversation.userTurn('the end');
    await flushMicrotasks();
    const ownerText = `${'x'.repeat(MAX_MERGED_TURN_CHARS - 'x the end'.length)}x the end`;
    expect(adapter.channels[1]!.turn.text).toBe(`${note} ${ownerText}`);
    expect(logger.events.find((e) => e.fields.event === 'turn_merged')?.fields).toMatchObject({
      text_chars: MAX_MERGED_TURN_CHARS,
    });
  });

  it('does not prefix normal, queued, or merge-skipped turns', async () => {
    const normal = setup();
    normal.conversation.userTurn('normal request');
    await flushMicrotasks();
    expect(normal.adapter.channels[0]!.turn.text).toBe('normal request');

    const queued = setup();
    queued.conversation.userTurn('working request');
    await flushMicrotasks();
    queued.adapter.channels[0]!.push({
      type: 'tool.start',
      tool_call_id: 't',
      tool_name: 'work',
    });
    await flushMicrotasks();
    queued.conversation.userTurn('follow-up request');
    await flushMicrotasks();
    queued.adapter.channels[0]!.done();
    await flushMicrotasks();
    expect(queued.adapter.channels[1]!.turn.text).toBe('follow-up request');

    const skipped = setup();
    skipped.conversation.userTurn('answered request');
    await flushMicrotasks();
    skipped.adapter.channels[0]!.push({ type: 'activity', label: 'Working' });
    await flushMicrotasks();
    skipped.conversation.userTurn('new request');
    await flushMicrotasks();
    expect(skipped.adapter.channels[1]!.turn.text).toBe('new request');
    expect(skipped.logger.names()).toContain('turn_merge_skipped');
  });

  it('never logs transcript text', async () => {
    const { conversation, logger } = setup();
    conversation.userTurn('secret alpha');
    await flushMicrotasks();
    conversation.userTurn('secret beta');
    await flushMicrotasks();
    expect(JSON.stringify(logger.events)).not.toMatch(/secret|alpha|beta/);
  });
});

describe('answered-ring opening line', () => {
  const prompt = '[The owner answered your call. Your ring message was already said.]';

  it('starts TTS before any agent event and shows the line as agent text', () => {
    const { adapter, conversation, speech, scheduler, logger, of } = setup();
    conversation.openingTurn(prompt, ' The build failed ');
    expect(speech.calls).toEqual(['begin gen_1', 'append gen_1 The build failed ']);
    expect(logger.events.find((e) => e.fields.event === 'opening_line')?.fields).toEqual({
      event: 'opening_line',
      call_id: CALL_ID,
      text_chars: 16,
    });
    expect(logger.names()).not.toContain('agent_first_event');
    expect(adapter.channels[0]!.turn.text).toBe(prompt);
    scheduler.advance(100);
    expect(of('agent_text').at(-1)).toMatchObject({ text: 'The build failed ', final: false });
    conversation.openingTurn('[again]', 'again');
    expect(adapter.channels).toHaveLength(1);
    expect(speech.calls).not.toContain('append gen_1 again ');
  });

  it('appends the agent stream after the line in the same generation', async () => {
    const { adapter, conversation, speech, scheduler, logger } = setup();
    conversation.openingTurn(prompt, 'The build failed');
    adapter.channels[0]!.text('I can walk you through it. ');
    await flushMicrotasks();
    expect(speech.calls).toEqual([
      'begin gen_1',
      'append gen_1 The build failed ',
      'append gen_1 I can walk you through it. ',
    ]);
    scheduler.advance(PROGRESS_LINE_AFTER_MS + OPENING_TURN_QUIET_MS);
    expect(logger.names()).not.toContain('progress_line');
    expect(speech.calls.join(' ')).not.toContain('Still working');
  });

  it('stops the line on barge-in but keeps the opening turn committed', async () => {
    const { adapter, conversation, speech, logger } = setup();
    conversation.openingTurn(prompt, 'The build failed');
    conversation.speechState('gen_1', 'playing');
    conversation.userSpeechStarted();
    conversation.userPartial('I need the details now');
    expect(speech.calls).toContain('cancel barge_in');
    expect(adapter.channels[0]!.signal.aborted).toBe(false);
    conversation.userTurn('I need the details now');
    await flushMicrotasks();
    expect(adapter.channels[0]!.turn.text).toBe(prompt);
    expect(adapter.channels[1]!.turn.text).toBe('I need the details now');
    expect(logger.names()).not.toContain('turn_merged');
  });

  it('keeps the opening prompt when the owner speaks before the line is heard', async () => {
    const { adapter, conversation, logger } = setup();
    conversation.openingTurn(prompt, 'The build failed');
    conversation.userTurn('What happened?');
    await flushMicrotasks();
    expect(adapter.channels[1]!.turn.text).toContain(`${prompt} What happened?`);
    expect(logger.names()).toContain('turn_merged');
  });

  it('an empty line starts no speech and leaves the prompt unchanged', async () => {
    const { adapter, conversation, speech, logger } = setup();
    conversation.openingTurn(prompt, '   ');
    await flushMicrotasks();
    expect(adapter.channels[0]!.turn.text).toBe(prompt);
    expect(speech.calls).toEqual([]);
    expect(logger.names()).not.toContain('opening_line');
  });
});

describe('ConversationController agent failure policy and limits', () => {
  const answer = async (adapter: ScriptedAdapter, index: number) => {
    const channel = adapter.channels[index]!;
    channel.push({ type: 'run.started' });
    channel.done();
    await flushMicrotasks();
  };

  it('a 401 ends the call even after the agent has answered', async () => {
    const unusable: string[] = [];
    const adapter = new ScriptedAdapter();
    const { conversation } = setup(adapter, (code) => unusable.push(code));
    conversation.userTurn('one');
    await flushMicrotasks();
    await answer(adapter, 0);
    conversation.userTurn('two');
    await flushMicrotasks();
    adapter.channels[1]!.fail(new AdapterError('auth_failed', { httpStatus: 401 }));
    await flushMicrotasks();
    expect(unusable).toEqual(['auth_failed']);
  });

  it('a 403 or an unreachable agent ends the call only before any turn was answered', async () => {
    for (const error of [
      () => new AdapterError('auth_failed', { httpStatus: 403 }),
      () => new AdapterError('connection_failed'),
    ]) {
      const unusable: string[] = [];
      const adapter = new ScriptedAdapter();
      const { conversation, of } = setup(adapter, (code) => unusable.push(code));
      conversation.userTurn('one');
      await flushMicrotasks();
      adapter.channels[0]!.fail(error());
      await flushMicrotasks();
      expect(unusable).toHaveLength(1);

      const laterUnusable: string[] = [];
      const later = setup(new ScriptedAdapter(), (code) => laterUnusable.push(code));
      later.conversation.userTurn('one');
      await flushMicrotasks();
      await answer(later.adapter, 0);
      later.conversation.userTurn('two');
      await flushMicrotasks();
      const failure = error();
      later.adapter.channels[1]!.fail(failure);
      await flushMicrotasks();
      expect(laterUnusable).toEqual([]);
      expect(later.of('notice').at(-1)?.code).toBe(
        failure.code === 'connection_failed' ? 'agent_unreachable' : 'agent_failed',
      );
      expect(of('notice')).toEqual([]);
    }
  });

  it('caps the text sent to the agent, keeping the most recent, and logs counts only', async () => {
    const { adapter, conversation, logger } = setup();
    conversation.userTurn(`secret ${'y'.repeat(MAX_USER_TURN_CHARS)} tail`);
    await flushMicrotasks();
    const text = adapter.channels[0]!.turn.text;
    expect(text).toHaveLength(MAX_USER_TURN_CHARS);
    expect(text.endsWith('y tail')).toBe(true);
    const capped = logger.events.find((e) => e.fields.event === 'turn_text_capped');
    expect(capped?.fields).toMatchObject({ sent_chars: MAX_USER_TURN_CHARS });
    expect(JSON.stringify(logger.events)).not.toMatch(/secret|tail/);
  });

  it('a non-streaming agent gets the notice once, on its first answered turn, not at connect', async () => {
    const adapter = new ScriptedAdapter();
    adapter.name = 'cord-native';
    adapter.capabilities.streamingText = false;
    const { conversation, of } = setup(adapter);
    await conversation.connect(new AbortController().signal);
    expect(of('notice')).toEqual([]);
    for (let i = 0; i < 2; i += 1) {
      conversation.userTurn(`turn ${i}`);
      await flushMicrotasks();
      await answer(adapter, i);
    }
    expect(of('notice').map((n) => n.code)).toEqual(['agent_not_streaming']);
  });

  it('a built-in test line that does not stream gets no notice', async () => {
    const adapter = new ScriptedAdapter();
    adapter.name = 'repeat';
    adapter.capabilities.streamingText = false;
    const { conversation, of } = setup(adapter);
    conversation.userTurn('hi');
    await flushMicrotasks();
    await answer(adapter, 0);
    expect(of('notice')).toEqual([]);
  });
});

describe('ConversationController floor-control words and short barge-in grace (ADR-017)', () => {
  it('recognises floor-control phrases, repeated or mixed, and nothing else', () => {
    for (const text of ['wait', 'Stop. Stop.', 'Hold on. Hold on.', 'shhh', 'excuse me, one sec']) {
      expect(isFloorControl(echoWords(text))).toBe(true);
    }
    for (const text of ['', 'Rate,', 'wait what', 'stop the timer', 'hold']) {
      expect(isFloorControl(echoWords(text))).toBe(false);
    }
  });

  for (const said of ['wait', 'Stop. Stop.', 'hang on']) {
    it(`a barge-in of only "${said}" is not sent; floor listening, answer stays cut`, async () => {
      const { adapter, speech, conversation, floors, agent, logger } = await speaking();
      conversation.userSpeechStarted();
      conversation.userTurn(said);
      await flushMicrotasks();
      expect(adapter.channels).toHaveLength(1);
      expect(speech.calls.filter((c) => c.startsWith('cancel'))).toEqual(['cancel barge_in']);
      expect(floors().at(-1)).toBe('listening');
      expect(logger.names()).toContain('floor_control');
      // The agent keeps working, muted: nothing more is spoken and the floor stays listening.
      expect(agent.signal.aborted).toBe(false);
      const before = floors().length;
      agent.text('More of the story.');
      agent.done();
      await flushMicrotasks();
      expect(speech.calls.join('|')).not.toContain('More');
      expect(floors().slice(before)).not.toContain('agent_working');
      expect(floors().at(-1)).toBe('listening');
    });
  }

  it('floor-control words, then a real turn: supersedes the muted agent turn as usual', async () => {
    const { adapter, conversation, agent } = await speaking();
    conversation.userSpeechStarted();
    conversation.userTurn('stop');
    await flushMicrotasks();
    conversation.userSpeechStarted();
    conversation.userTurn('tell me about Paris');
    await flushMicrotasks();
    expect(agent.signal.aborted).toBe(true);
    expect(adapter.cancelled).toEqual(['turn_1']);
    expect(adapter.channels[1]!.turn.text).toBe('tell me about Paris');
  });

  it('a clipped short barge-in merges into the next words, even past the grace', async () => {
    const { adapter, conversation, scheduler, floors, logger } = await speaking();
    conversation.userSpeechStarted();
    conversation.userTurn('Rate,');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(floors().at(-1)).toBe('listening');
    scheduler.advance(SHORT_BARGE_IN_GRACE_MS - 100);
    conversation.userSpeechStarted();
    expect(floors().at(-1)).toBe('user_speaking');
    scheduler.advance(2000); // the grace ends while the caller is still talking
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    conversation.userTurn('what time is it');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    expect(adapter.channels[1]!.turn.text).toBe('Rate, what time is it');
    const released = logger.events.find((e) => e.fields.event === 'short_turn_released');
    expect(released?.fields).toMatchObject({ words: 1, merged: true });
    // agent_working only for turn_1 before the cut and turn_2 once it is sent.
    expect(floors().filter((f) => f === 'agent_working')).toHaveLength(2);
    expect(floors().at(-1)).toBe('agent_working');
  });

  it('a short barge-in followed by silence is sent alone after the grace', async () => {
    const { adapter, conversation, scheduler, floors, logger } = await speaking();
    conversation.userSpeechStarted();
    conversation.userTurn('Right?');
    await flushMicrotasks();
    scheduler.advance(SHORT_BARGE_IN_GRACE_MS - 1);
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(floors().at(-1)).toBe('listening');
    scheduler.advance(1);
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    expect(adapter.channels[1]!.turn.text).toBe('Right?');
    expect(floors().at(-1)).toBe('agent_working');
    const released = logger.events.find((e) => e.fields.event === 'short_turn_released');
    expect(released?.fields).toMatchObject({ words: 1, merged: false });
  });

  it('noise during the grace keeps holding; the held text goes out when the grace ends', async () => {
    const { adapter, conversation, scheduler, floors } = await speaking();
    conversation.userSpeechStarted();
    conversation.userTurn('Right?');
    scheduler.advance(500);
    conversation.userSpeechStarted();
    conversation.userSpeechDiscarded();
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(floors().at(-1)).toBe('listening');
    scheduler.advance(1000);
    await flushMicrotasks();
    expect(adapter.channels[1]!.turn.text).toBe('Right?');
  });

  it('noise that outlasts the grace releases the held text when it is discarded', async () => {
    const { adapter, conversation, scheduler } = await speaking();
    conversation.userSpeechStarted();
    conversation.userTurn('Right?');
    scheduler.advance(1000);
    conversation.userSpeechStarted();
    scheduler.advance(1000);
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    conversation.userSpeechDiscarded();
    await flushMicrotasks();
    expect(adapter.channels[1]!.turn.text).toBe('Right?');
  });

  it('a 1–2 word answer while the agent is not audible is sent immediately', async () => {
    const { adapter, conversation, agent, scheduler } = await speaking();
    agent.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished');
    scheduler.advance(ECHO_FINISHED_TAIL_MS);
    conversation.userSpeechStarted();
    conversation.userTurn('yes');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    expect(adapter.channels[1]!.turn.text).toBe('yes');
  });

  it('"stop" while nothing runs is not a turn: there is no work to stop (ADR-028)', async () => {
    const { adapter, conversation } = setup();
    conversation.userSpeechStarted();
    conversation.userTurn('stop');
    await flushMicrotasks();
    expect(adapter.channels).toEqual([]);
  });

  it('closing during the grace sends nothing and leaves no timers', async () => {
    const { adapter, conversation, scheduler } = await speaking();
    conversation.userSpeechStarted();
    conversation.userTurn('Right?');
    conversation.close();
    await flushMicrotasks();
    expect(scheduler.pending).toBe(0);
    scheduler.advance(SHORT_BARGE_IN_GRACE_MS);
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
  });

  it('never logs what was said on the floor-control and grace paths', async () => {
    const { conversation, scheduler, logger } = await speaking();
    conversation.userSpeechStarted();
    conversation.userTurn('hold on');
    await flushMicrotasks();
    const second = await speaking();
    second.conversation.userSpeechStarted();
    second.conversation.userTurn('secret');
    second.scheduler.advance(SHORT_BARGE_IN_GRACE_MS);
    await flushMicrotasks();
    scheduler.advance(SHORT_BARGE_IN_GRACE_MS);
    expect(logger.names()).toContain('floor_control');
    expect(second.logger.names()).toContain('short_turn_held');
    expect(second.logger.names()).toContain('short_turn_released');
    const logged = JSON.stringify([...logger.events, ...second.logger.events]);
    expect(logged).not.toMatch(/secret|hold on/i);
  });
});

describe('ConversationController short normal turn hold (ADR-017 amendment)', () => {
  const hold = { shortTurnHoldMs: 800 };

  it('holds one word until 800 ms, then sends it alone with reasoned logs', async () => {
    const { adapter, conversation, scheduler, logger, floors } = setup(
      undefined,
      undefined,
      undefined,
      hold,
    );
    conversation.userSpeechStarted();
    conversation.userTurn('Okay.');
    expect(floors().at(-1)).toBe('listening');
    expect(logger.events.find((e) => e.fields.event === 'short_turn_held')?.fields).toMatchObject({
      words: 1,
      reason: 'turn',
    });
    scheduler.advance(799);
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(0);
    scheduler.advance(1);
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['Okay.']);
    expect(
      logger.events.find((e) => e.fields.event === 'short_turn_released')?.fields,
    ).toMatchObject({ words: 1, merged: false, reason: 'turn' });
  });

  it('merges the next words within 800 ms and keeps the first speech start', async () => {
    let wallTime = Date.UTC(2026, 8, 26, 12, 0, 0);
    const { adapter, conversation, scheduler, logger } = setup(undefined, undefined, undefined, {
      ...hold,
      wallClock: () => wallTime,
    });
    conversation.userSpeechStarted();
    conversation.userTurn('Okay.');
    scheduler.advance(500);
    wallTime += 500;
    conversation.userSpeechStarted();
    conversation.userTurn('so what about the tests');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(adapter.channels[0]!.turn.text).toBe('Okay. so what about the tests');
    expect(adapter.channels[0]!.turn.startedAt).toBe(new Date(wallTime - 500).toISOString());
    expect(
      logger.events.find((e) => e.fields.event === 'short_turn_released')?.fields,
    ).toMatchObject({ words: 1, merged: true, reason: 'turn' });
  });

  it('keeps the hold when speech starts before 800 ms and commits after it', async () => {
    const { adapter, conversation, scheduler } = setup(undefined, undefined, undefined, hold);
    conversation.userSpeechStarted();
    conversation.userTurn('Okay.');
    scheduler.advance(700);
    conversation.userSpeechStarted();
    scheduler.advance(200);
    expect(adapter.channels).toHaveLength(0);
    conversation.userTurn('so what about the tests');
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['Okay. so what about the tests']);
  });

  it('sends three words, stop requests, and floor-control words without a hold', async () => {
    const three = setup(undefined, undefined, undefined, hold);
    three.conversation.userTurn('Tell me more');
    expect(three.adapter.channels.map((c) => c.turn.text)).toEqual(['Tell me more']);

    const working = setup(undefined, undefined, undefined, hold);
    working.conversation.userTurn('Check the build');
    working.conversation.userTurn('Stop');
    await flushMicrotasks();
    expect(working.adapter.channels).toHaveLength(1);
    expect(working.adapter.channels[0]!.signal.aborted).toBe(true);
    expect(working.logger.names()).toContain('agent_stop_requested');
    expect(working.logger.names()).not.toContain('short_turn_held');

    const floor = setup(undefined, undefined, undefined, hold);
    floor.conversation.userTurn('wait');
    expect(floor.adapter.channels).toHaveLength(0);
    expect(floor.logger.names()).toContain('stop_request_dropped');
    expect(floor.logger.names()).not.toContain('short_turn_held');
  });

  it('accepts a pending approval answer immediately', async () => {
    const { adapter, conversation, logger } = setup(undefined, undefined, undefined, hold);
    conversation.userTurn('Please do it');
    adapter.channels[0]!.push({
      type: 'approval.required',
      approval_id: 'apr_short_hold',
      action: 'run_command',
      title: 'Run command',
    });
    await flushMicrotasks();
    conversation.userTurn('yes');
    expect(adapter.approvalDecisions).toEqual([{ id: 'apr_short_hold', decision: 'approve' }]);
    expect(logger.names()).not.toContain('short_turn_held');
  });

  it.each([undefined, 0])('sends a normal one-word turn immediately with hold %s', (ms) => {
    const { adapter, conversation } = setup(undefined, undefined, undefined, {
      shortTurnHoldMs: ms,
    });
    conversation.userTurn('Okay.');
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['Okay.']);
  });

  it('keeps the floor listening and plays no presence cue while a normal turn is held', async () => {
    const { adapter, conversation, scheduler, logger, floors, speech } = setup(
      undefined,
      undefined,
      undefined,
      { ...hold, presenceCues: true },
    );
    conversation.userTurn('Check the build');
    conversation.userSpeechStarted();
    conversation.userTurn('Okay.');
    expect(floors().at(-1)).toBe('listening');
    scheduler.advance(799);
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(logger.names()).not.toContain('presence_tone');
    expect(speech.calls.join(' ')).not.toContain('Still working');
    expect(floors().at(-1)).toBe('listening');
    scheduler.advance(1);
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);

    const nearProgress = setup(undefined, undefined, undefined, { ...hold, presenceCues: true });
    nearProgress.conversation.userTurn('Check the build');
    nearProgress.scheduler.advance(PROGRESS_LINE_AFTER_MS - 500);
    nearProgress.conversation.userSpeechStarted();
    nearProgress.conversation.userTurn('Okay.');
    const linesBefore = nearProgress.speech.calls.length;
    nearProgress.scheduler.advance(799);
    expect(nearProgress.speech.calls).toHaveLength(linesBefore);
    expect(nearProgress.floors().at(-1)).toBe('listening');
  });
});

describe('ConversationController ADR-017 and keep talking, milestone 5 pass (verifier)', () => {
  it('BUG: "Wait. Wait.": a clipped first word held, then a floor-control-only follow-up, sends nonsense to the agent', async () => {
    // ADR-017 context: the first "wait" is clipped to "Rate,", the repeat is heard as "Wait.".
    const { adapter, conversation, scheduler, floors } = await speaking();
    conversation.userSpeechStarted();
    conversation.userTurn('Rate,');
    await flushMicrotasks();
    scheduler.advance(600);
    conversation.userSpeechStarted();
    conversation.userTurn('Wait.');
    await flushMicrotasks();
    scheduler.advance(SHORT_BARGE_IN_GRACE_MS);
    await flushMicrotasks();
    // The caller only asked for the floor: nothing should reach the agent.
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['tell me a story']);
    expect(floors().at(-1)).toBe('listening');
  });

  it('keep talking after a tool ran: the new words are queued, the request is never re-sent', async () => {
    const { adapter, conversation } = setup();
    conversation.userTurn('email Bob the report');
    await flushMicrotasks();
    const first = adapter.channels[0]!;
    first.push({ type: 'tool.start', tool_call_id: 't1', tool_name: 'send_email' });
    first.push({ type: 'tool.end', tool_call_id: 't1', status: 'success' });
    await flushMicrotasks();
    // Nothing audible yet (no preamble); the caller keeps talking.
    conversation.userTurn('and tell him thanks');
    await flushMicrotasks();
    // ADR-026: the working turn is not cancelled; the new words wait for it.
    expect(adapter.channels).toHaveLength(1);
    expect(adapter.cancelled).toEqual([]);
    first.done();
    await flushMicrotasks();
    // The email already went out; merging would ask the agent to send it again.
    expect(adapter.channels[1]!.turn.text).toBe('and tell him thanks');
  });

  it('BUG: keep talking re-sends a turn the agent already completed but that was not played yet', async () => {
    const { adapter, conversation } = setup();
    conversation.userTurn('book a table for two');
    await flushMicrotasks();
    const first = adapter.channels[0]!;
    first.text('Booked for seven.');
    first.done();
    await flushMicrotasks();
    // TTS has not started playing the confirmation when the caller speaks again.
    conversation.userTurn('also order flowers');
    await flushMicrotasks();
    expect(adapter.channels[1]!.turn.text).toBe('also order flowers');
  });

  it('a short reply while the agent is still working after a tool waits for its turn to end (ADR-026)', async () => {
    const { adapter, conversation, scheduler, speech } = await speaking();
    const agent = adapter.channels[0]!;
    agent.push({ type: 'tool.start', tool_call_id: 't', tool_name: 'x' });
    await flushMicrotasks();
    conversation.speechState('gen_1', 'finished');
    agent.push({ type: 'tool.end', tool_call_id: 't', status: 'success' });
    agent.text('Shall I continue?');
    await flushMicrotasks();
    expect(speech.calls).toContain('begin gen_2');
    scheduler.advance(ECHO_FINISHED_TAIL_MS + 1);
    conversation.userSpeechStarted();
    conversation.userTurn('yes');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    agent.done();
    await flushMicrotasks();
    conversation.speechState('gen_2', 'finished');
    expect(adapter.channels).toHaveLength(2);
    expect(adapter.channels[1]!.turn.text).toBe('yes');
  });

  it('held text is sent exactly once when the grace expires mid-utterance and the utterance is then discarded', async () => {
    const { adapter, conversation, scheduler } = await speaking();
    conversation.userSpeechStarted();
    conversation.userTurn('Right?');
    scheduler.advance(1000);
    conversation.userSpeechStarted();
    scheduler.advance(1000); // expired while talking
    conversation.userSpeechDiscarded();
    await flushMicrotasks();
    // The agent answers the released turn audibly, so the next turn is not a "keep talking" merge.
    adapter.channels[1]!.text('Yes. ');
    await flushMicrotasks();
    conversation.speechState('gen_2', 'playing');
    scheduler.advance(10_000);
    conversation.userSpeechStarted();
    conversation.userPartial('what about');
    conversation.userTurn('what about tomorrow');
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual([
      'tell me a story',
      'Right?',
      'what about tomorrow',
    ]);
  });

  it('an echo commit during the grace does not merge; the held text still goes out once, alone', async () => {
    const { adapter, conversation, scheduler, speech } = await speaking();
    speech.totals.set('gen_1', 2000);
    conversation.userSpeechStarted();
    conversation.userTurn('Rate,');
    await flushMicrotasks();
    scheduler.advance(200); // within the cut generation's echo tail
    conversation.userSpeechStarted();
    conversation.userTurn('part one'); // the agent's own words, committed by STT
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    scheduler.advance(SHORT_BARGE_IN_GRACE_MS);
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['tell me a story', 'Rate,']);
  });

  it('the muted turn running tools during the grace never moves the floor off listening', async () => {
    const { adapter, conversation, floors } = await speaking();
    conversation.userSpeechStarted();
    conversation.userTurn('Rate,');
    await flushMicrotasks();
    const before = floors().length;
    const agent = adapter.channels[0]!;
    agent.push({
      type: 'tool.start',
      tool_call_id: 't',
      tool_name: 'x',
      display_label: 'Looking…',
    });
    agent.push({ type: 'activity', label: 'Still looking…' });
    await flushMicrotasks();
    expect(floors().slice(before)).toEqual([]);
    expect(floors().at(-1)).toBe('listening');
  });

  it('the muted yielded turn timing out during the grace does not send the held text early or twice', async () => {
    const { adapter, conversation, scheduler } = setup();
    conversation.userTurn('tell me a story');
    await flushMicrotasks();
    const agent = adapter.channels[0]!;
    agent.text('Part one ');
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    scheduler.advance(AGENT_TIMEOUTS.idleMs - 100);
    conversation.userSpeechStarted();
    conversation.userTurn('Rate,');
    await flushMicrotasks();
    scheduler.advance(200); // idle budget of the muted turn runs out inside the grace
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    scheduler.advance(SHORT_BARGE_IN_GRACE_MS);
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['tell me a story', 'Rate,']);
  });
});

describe('ConversationController a working agent is not interrupted by more talk (ADR-026)', () => {
  const toolStart = { type: 'tool.start', tool_call_id: 't', tool_name: 'search' } as const;
  const fields = (logger: ReturnType<typeof recordingLogger>, event: string) =>
    logger.events.filter((e) => e.fields.event === event).map((e) => e.fields);

  it('recognises short stop requests, case- and punctuation-insensitively', () => {
    for (const text of [
      'Stop.',
      'CANCEL!',
      'wait, wait',
      'Hold on',
      'Never mind.',
      'nevermind',
      'Stop it!',
      'cancel that',
      'hang on',
      'stop, stop, stop, stop',
    ]) {
      expect(isStopRequest(text), text).toBe(true);
    }
    for (const text of [
      '',
      'stop stop stop stop stop stop stop',
      'stop the build',
      'cancel my meeting',
      'wait for the tests',
      'sorry',
      'never mind that one',
    ]) {
      expect(isStopRequest(text), text).toBe(false);
    }
    expect(STOP_REQUEST_WORDS).toEqual(expect.arrayContaining(['stop', 'cancel', 'never mind']));
    expect(new Set(STOP_REQUEST_WORDS).size).toBe(STOP_REQUEST_WORDS.length);
  });

  it('queues talk while a tool runs, merges it, and sends it once the turn is done', async () => {
    const { adapter, conversation, logger, speech } = setup();
    conversation.userTurn('check the build');
    await flushMicrotasks();
    const first = adapter.channels[0]!;
    first.push(toolStart);
    await flushMicrotasks();
    conversation.userTurn('and the tests');
    conversation.userTurn('then tell me');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(adapter.cancelled).toEqual([]);
    expect(first.signal.aborted).toBe(false);
    expect(fields(logger, 'turn_queued').map((f) => f.queued_turns)).toEqual([1, 2]);
    expect(logger.names()).not.toContain('agent_turn_superseded');
    // The current turn's answer still plays normally.
    first.push({ type: 'tool.end', tool_call_id: 't', status: 'success' });
    first.text('The build is green.');
    first.done();
    await flushMicrotasks();
    expect(speech.calls.filter((c) => c.startsWith('append gen_1')).join('')).toMatch(
      /build.*green/,
    );
    // The agent is done: the queue goes now, while the answer plays (owner decision 2026-11-12).
    expect(adapter.channels).toHaveLength(2);
    expect(speech.calls).not.toContain('cancel superseded');
    expect(adapter.channels[1]!.turn.text).toBe('and the tests then tell me');
    expect(fields(logger, 'queued_turn_sent')).toEqual([
      expect.objectContaining({ queued_turns: 2 }),
    ]);
  });

  it('caps queued text like merged text, keeping the most recent words', async () => {
    const { adapter, conversation } = setup();
    conversation.userTurn('deploy it');
    await flushMicrotasks();
    adapter.channels[0]!.push(toolStart);
    await flushMicrotasks();
    conversation.userTurn(`A${'a'.repeat(1499)}`);
    conversation.userTurn(`B${'b'.repeat(1499)}`);
    adapter.channels[0]!.done();
    await flushMicrotasks();
    const sent = adapter.channels[1]!.turn.text;
    expect(sent.length).toBeLessThanOrEqual(MAX_MERGED_TURN_CHARS);
    expect(sent.endsWith(`B${'b'.repeat(1499)}`)).toBe(true);
  });

  it('a stop request cancels the working turn and drops the queue', async () => {
    const { adapter, conversation, logger } = setup();
    conversation.userTurn('rename every file');
    await flushMicrotasks();
    const first = adapter.channels[0]!;
    first.push(toolStart);
    await flushMicrotasks();
    conversation.userTurn('and zip them');
    conversation.userTurn('Stop!');
    await flushMicrotasks();
    expect(first.signal.aborted).toBe(true);
    expect(adapter.cancelled).toEqual(['turn_1']);
    expect(fields(logger, 'queued_turn_dropped')).toEqual([
      expect.objectContaining({ reason: 'stop_request', queued_turns: 1 }),
    ]);
    expect(logger.names()).toContain('agent_stop_requested');
    // Neither the stop (ADR-028) nor the dropped queue reaches the agent.
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['rename every file']);
  });

  it('without a tool started, more talk still supersedes and merges', async () => {
    const { adapter, conversation, logger } = setup();
    conversation.userTurn('what is the weather');
    await flushMicrotasks();
    adapter.channels[0]!.push({ type: 'run.started' });
    await flushMicrotasks();
    conversation.userTurn('in Chennai');
    await flushMicrotasks();
    expect(adapter.cancelled).toEqual(['turn_1']);
    expect(adapter.channels[1]!.turn.text).toBe(
      '[Your last reply was cut off because I kept talking. Here is my full request:] what is the weather in Chennai',
    );
    expect(logger.names()).not.toContain('turn_queued');
  });

  it('after the agent was cut off mid-speech but still runs tools, talk is queued', async () => {
    const { adapter, conversation, speech } = setup();
    conversation.userTurn('find my invoices');
    await flushMicrotasks();
    const first = adapter.channels[0]!;
    first.text('Looking now. ');
    first.push(toolStart);
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    conversation.userSpeechStarted();
    conversation.userPartial('also check receipts');
    expect(speech.calls).toContain('cancel barge_in');
    conversation.userTurn('also check receipts');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(adapter.cancelled).toEqual([]);
    first.done();
    await flushMicrotasks();
    expect(adapter.channels[1]!.turn.text).toBe('also check receipts');
  });

  it('a queued turn wins over a hang-up marker in the current answer', async () => {
    const adapter = new ScriptedAdapter();
    const scheduler = new ManualScheduler();
    const logger = recordingLogger();
    let hangups = 0;
    const conversation = new ConversationController({
      callId: CALL_ID,
      adapter,
      speech: new RecordingSpeech(),
      scheduler,
      logger,
      send: () => undefined,
      onAgentHangup: () => (hangups += 1),
    });
    conversation.userTurn('book the flight');
    await flushMicrotasks();
    const first = adapter.channels[0]!;
    first.push(toolStart);
    await flushMicrotasks();
    conversation.userTurn('and a hotel');
    first.text('Booked. Bye! ⟪hangup⟫');
    first.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    conversation.speechState('gen_1', 'finished');
    await flushMicrotasks();
    scheduler.advance(AGENT_HANGUP_LINGER_MS * 2);
    expect(hangups).toBe(0);
    expect(logger.names()).not.toContain('agent_hangup_requested');
    expect(fields(logger, 'queued_turn_sent')[0]).toEqual(
      expect.objectContaining({ hangup_skipped: true }),
    );
    expect(adapter.channels[1]!.turn.text).toBe('and a hotel');
  });

  it('drops the queue when the call ends', async () => {
    const { adapter, conversation, logger } = setup();
    conversation.userTurn('run the report');
    await flushMicrotasks();
    adapter.channels[0]!.push(toolStart);
    await flushMicrotasks();
    conversation.userTurn('and email it');
    conversation.close();
    adapter.channels[0]!.done();
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(fields(logger, 'queued_turn_dropped')).toEqual([
      expect.objectContaining({ reason: 'call_ended' }),
    ]);
  });
});

describe('ConversationController ADR-026 queue, verifier pass', () => {
  const toolStart = { type: 'tool.start', tool_call_id: 't', tool_name: 'search' } as const;
  const toolEnd = { type: 'tool.end', tool_call_id: 't', status: 'success' } as const;
  const fields = (logger: ReturnType<typeof recordingLogger>, event: string) =>
    logger.events.filter((e) => e.fields.event === event).map((e) => e.fields);

  /** A turn that has started a tool, with `queued` said while it works. */
  async function working(queued?: string) {
    const s = setup();
    s.conversation.userTurn('check the build');
    await flushMicrotasks();
    const first = s.adapter.channels[0]!;
    first.push(toolStart);
    await flushMicrotasks();
    if (queued !== undefined) {
      s.conversation.userSpeechStarted();
      s.conversation.userTurn(queued);
      await flushMicrotasks();
    }
    return { ...s, first };
  }

  function hangupSetup() {
    const adapter = new ScriptedAdapter();
    const scheduler = new ManualScheduler();
    const hangups = { count: 0 };
    const conversation = new ConversationController({
      callId: CALL_ID,
      adapter,
      speech: new RecordingSpeech(),
      scheduler,
      logger: recordingLogger(),
      send: () => undefined,
      onAgentHangup: () => (hangups.count += 1),
    });
    return { adapter, scheduler, hangups, conversation };
  }

  // Owner decision 2026-11-12: words held while the agent worked go to the agent as soon as it is
  // done, while its answer still plays; the next answer waits behind it, so nothing overlaps.
  it('sends the queue as soon as the agent is done, while its answer plays; the next answer follows it', async () => {
    const { adapter, conversation, first, speech, logger } = await working('and the tests');
    first.push(toolEnd);
    first.text('The build passed.');
    first.done();
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['check the build', 'and the tests']);
    expect(fields(logger, 'queued_turn_sent')).toEqual([
      expect.objectContaining({ queued_turns: 1, early: true }),
    ]);
    conversation.speechState('gen_1', 'playing');
    const second = adapter.channels[1]!;
    second.text('All tests pass.');
    second.done();
    await flushMicrotasks();
    expect(speech.calls.join('|')).not.toContain('All tests');
    expect(speech.calls.at(-1)).toBe('end gen_1');
    const before = speech.calls.length;
    conversation.speechState('gen_1', 'finished');
    expect(speech.calls.slice(before)).toEqual([
      'begin gen_2',
      'append gen_2 All tests pass.',
      'end gen_2',
    ]);
    expect(speech.calls).not.toContain('cancel superseded');
  });

  it('a barge-in on the first answer after the early send cuts it, and the next answer waits for the owner', async () => {
    const { adapter, conversation, first, speech } = await working('and the tests');
    first.push(toolEnd);
    first.text('The build passed and the report is ready to go out now.');
    first.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    conversation.userSpeechStarted();
    conversation.userPartial('hang on a second');
    expect(speech.calls).toContain('cancel barge_in');
    const second = adapter.channels[1]!;
    expect(second.signal.aborted).toBe(false);
    second.text('All tests pass.');
    second.done();
    await flushMicrotasks();
    expect(speech.calls.join('|')).not.toContain('All tests pass');
    conversation.userSpeechDiscarded(); // it was noise after all
    expect(speech.calls.slice(-3)).toEqual([
      'begin gen_2',
      'append gen_2 All tests pass.',
      'end gen_2',
    ]);
  });

  it('text the first turn still holds keeps the queue waiting until it has played', async () => {
    const { adapter, conversation, first } = await working('and the tests');
    first.text('Checking now. ');
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    first.push({ type: 'activity', label: 'Running' }); // closes gen_1; later text is held behind it
    first.text('The build passed.');
    first.done();
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
  });

  it('BUG: the queue is not sent while the owner is still talking; their commit takes it along', async () => {
    const { adapter, conversation, first, logger } = await working('and the tests');
    conversation.userSpeechStarted(); // the owner goes on talking
    first.push(toolEnd);
    first.done(); // finishes silently while they talk
    await flushMicrotasks();
    // Sending now starts a prompt their commit cancels a moment later (ACP: "not processed").
    expect(adapter.channels).toHaveLength(1);
    conversation.userTurn('and the lint');
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual([
      'check the build',
      'and the tests and the lint',
    ]);
    expect(adapter.cancelled).toEqual([]);
    expect(fields(logger, 'queued_turn_sent')).toEqual([
      expect.objectContaining({ queued_turns: 1 }),
    ]);
    expect(conversation.usage().turns).toBe(2);
  });

  it('after the early send, words over the first answer join the queued request (keep talking)', async () => {
    const { adapter, conversation, first, speech } = await working('also email Ram');
    first.push(toolEnd);
    first.text('The build is green and the report is ready to go out now.');
    first.done();
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['check the build', 'also email Ram']);
    conversation.speechState('gen_1', 'playing');
    conversation.userSpeechStarted();
    conversation.userPartial('no use the staging one');
    expect(speech.calls).toContain('cancel barge_in');
    conversation.userTurn('no use the staging one');
    await flushMicrotasks();
    // The queued request had done nothing yet: it is merged with the correction, never lost.
    expect(adapter.channels[2]!.turn.text).toMatch(/also email Ram no use the staging one$/);
    expect(adapter.cancelled).toEqual(['turn_2']);
  });

  it('BUG: an activity in the queued turn before the owner commits no longer loses the queued words', async () => {
    const { adapter, conversation, first } = await working('send the invoice to Ram');
    conversation.userSpeechStarted();
    first.done();
    await flushMicrotasks();
    // Old behaviour: the queue went out here, reported an activity, and the commit below
    // superseded it without merging (agent_acted): the queued request was cancelled and lost.
    adapter.channels[1]?.push({ type: 'activity', label: 'Thinking' });
    await flushMicrotasks();
    conversation.userTurn('and copy me');
    await flushMicrotasks();
    expect(adapter.channels.at(-1)!.turn.text).toContain('send the invoice to Ram');
    expect(adapter.cancelled).toEqual([]);
  });

  it('a deferred queue goes out when the owner’s speech turns out to be noise', async () => {
    const { adapter, conversation, first } = await working('and the tests');
    conversation.userSpeechStarted();
    first.done();
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    conversation.userSpeechDiscarded();
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['check the build', 'and the tests']);
  });

  it('a short barge-in over the first answer after the early send joins the queued request', async () => {
    const { adapter, conversation, first, scheduler } = await working('and the tests');
    first.text('All green so far and more to say about it.');
    first.done();
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    conversation.speechState('gen_1', 'playing');
    conversation.userSpeechStarted();
    conversation.userPartial('also lint');
    conversation.userTurn('also lint');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2); // held for its grace
    scheduler.advance(SHORT_BARGE_IN_GRACE_MS);
    await flushMicrotasks();
    expect(adapter.channels[2]!.turn.text).toMatch(/and the tests also lint$/);
  });

  it('"stop" over the first answer after the early send stops the queued request', async () => {
    const { adapter, conversation, first, logger } = await working('and delete the old ones');
    first.text('Found twelve files in the folder that match.');
    first.done();
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    conversation.speechState('gen_1', 'playing');
    conversation.userSpeechStarted();
    conversation.userPartial('stop');
    conversation.userTurn('Stop.');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    expect(adapter.channels[1]!.signal.aborted).toBe(true);
    expect(logger.names()).toContain('agent_stop_requested');
  });

  it('other floor-control words over the answer send the queue once the owner yields', async () => {
    const { adapter, conversation, first } = await working('and the tests');
    first.text('Found twelve files in the folder that match.');
    first.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    conversation.userSpeechStarted();
    conversation.userPartial('sorry');
    conversation.userTurn('Sorry.');
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['check the build', 'and the tests']);
  });

  it('BUG: a stop request is never merged with the unanswered request it cancels', async () => {
    const { adapter, conversation, logger } = setup();
    conversation.userTurn('delete all my emails');
    await flushMicrotasks();
    adapter.channels[0]!.push({ type: 'run.started' });
    await flushMicrotasks();
    conversation.userTurn('Stop!');
    await flushMicrotasks();
    expect(adapter.cancelled).toEqual(['turn_1']);
    // Merging ("keep talking") re-sent "delete all my emails Stop!": the request being cancelled.
    // Since ADR-028 the stop is not sent at all.
    expect(adapter.channels).toHaveLength(1);
    expect(logger.names()).not.toContain('turn_merged');
  });

  it('a stop request while nothing runs is never sent to the agent (ADR-028)', async () => {
    const { adapter, conversation, logger, speech } = setup();
    conversation.userTurn('Stop.');
    await flushMicrotasks();
    expect(adapter.channels).toEqual([]);
    expect(adapter.cancelled).toEqual([]);
    expect(speech.calls).toEqual([]);
    expect(logger.names()).toContain('stop_request_dropped');
    expect(logger.names()).not.toContain('agent_stop_requested');
  });

  it('a stop word inside a longer sentence is queued, never a cancel', async () => {
    const { adapter, conversation, first } = await working();
    for (const text of ['wait, also send it to Ram', 'Stop the build after tests', 'wait also']) {
      conversation.userTurn(text);
    }
    await flushMicrotasks();
    expect(first.signal.aborted).toBe(false);
    expect(adapter.cancelled).toEqual([]);
    first.done();
    await flushMicrotasks();
    expect(adapter.channels[1]!.turn.text).toBe(
      'wait, also send it to Ram Stop the build after tests wait also',
    );
  });

  it('stop requests survive Unicode punctuation and casing', () => {
    for (const text of [
      'STOP!!!',
      '¡Stop!',
      'Stop…',
      'stop, stop',
      'Wait… wait.',
      'Never-mind.',
      '“Cancel that.”',
      'Hold on, hold on',
      'stop 🛑',
      ' \n stop \t',
    ]) {
      expect(isStopRequest(text), text).toBe(true);
    }
    for (const text of ['…', '🛑', 'stopwatch', 'unstop', 'waiter', 'cancel it now please']) {
      expect(isStopRequest(text), text).toBe(false);
    }
  });

  it('queues ever-growing talk within the merged cap while the agent never finishes', async () => {
    const { adapter, conversation, first, logger } = await working();
    for (let i = 0; i < 200; i += 1) conversation.userTurn(`note ${i} ${'x'.repeat(90)}`);
    await flushMicrotasks();
    const last = fields(logger, 'turn_queued').at(-1)!;
    expect(last.queued_turns).toBe(200);
    expect(last.text_chars as number).toBeLessThanOrEqual(MAX_MERGED_TURN_CHARS);
    first.done();
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    expect(adapter.channels[1]!.turn.text.length).toBeLessThanOrEqual(MAX_MERGED_TURN_CHARS);
    expect(adapter.channels[1]!.turn.text.endsWith(`note 199 ${'x'.repeat(90)}`)).toBe(true);
  });

  for (const end of ['error', 'stream', 'idle', 'total'] as const) {
    it(`sends the queue once when the working turn ends by ${end}`, async () => {
      const { adapter, conversation, first, scheduler, of } = await working('and the tests');
      if (end === 'error') first.push({ type: 'error', code: 'boom', retryable: false });
      if (end === 'stream') first.fail(new Error('socket closed'));
      if (end === 'idle') scheduler.advance(AGENT_TIMEOUTS.idleMs);
      if (end === 'total') {
        for (let t = 0; t < AGENT_TIMEOUTS.totalMs; t += 10_000) {
          first.push({ type: 'activity', label: 'Working…' });
          await flushMicrotasks();
          scheduler.advance(10_000);
        }
      }
      await flushMicrotasks();
      expect(adapter.channels.map((c) => c.turn.text)).toEqual([
        'check the build',
        'and the tests',
      ]);
      expect(first.signal.aborted).toBe(true);
      expect(of('notice').length).toBeGreaterThan(0);
      expect(conversation.usage()).toMatchObject({ turns: 2, failed: 1 });
    });
  }

  it('a queued turn that is answered keeps usage counts right', async () => {
    const { adapter, conversation, first } = await working('and the tests');
    conversation.userTurn('and the docs');
    first.done();
    await flushMicrotasks();
    adapter.channels[1]!.done();
    await flushMicrotasks();
    expect(conversation.usage()).toEqual({ turns: 2, completed: 2, failed: 0, bargeIns: 0 });
  });

  it('TTS failing on the working turn’s answer still sends the queue once', async () => {
    const { adapter, conversation, first } = await working('and the tests');
    first.text('Here is the answer.');
    first.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'failed');
    conversation.speechState('gen_1', 'failed');
    conversation.speechState('gen_1', 'finished');
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['check the build', 'and the tests']);
  });

  it('the answered-ring opening turn queues talk once it works with tools', async () => {
    const { adapter, conversation } = setup();
    conversation.openingTurn('[The owner answered your call.]');
    await flushMicrotasks();
    adapter.channels[0]!.push(toolStart);
    await flushMicrotasks();
    conversation.userTurn('hello?');
    conversation.openingTurn('[again]'); // ignored: a turn exists
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    adapter.channels[0]!.done();
    await flushMicrotasks();
    expect(adapter.channels.map((c) => c.turn.text)).toEqual([
      '[The owner answered your call.]',
      'hello?',
    ]);
  });

  it('a marker reply that ends while the owner talks, with a queue: no hang-up, the queue goes with their words', async () => {
    const { adapter, scheduler, hangups, conversation } = hangupSetup();
    conversation.userTurn('book it');
    await flushMicrotasks();
    adapter.channels[0]!.push(toolStart);
    await flushMicrotasks();
    conversation.userTurn('and a cab');
    adapter.channels[0]!.text('Done. Bye ⟪hangup⟫');
    adapter.channels[0]!.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    conversation.userSpeechStarted();
    conversation.speechState('gen_1', 'finished');
    conversation.userTurn('for six pm');
    await flushMicrotasks();
    scheduler.advance(AGENT_HANGUP_LINGER_MS * 3);
    expect(hangups.count).toBe(0);
    expect(adapter.channels.at(-1)!.turn.text).toContain('and a cab');
  });

  it('an agent that ends every reply with the marker hangs up only after a reply with no queue', async () => {
    const { adapter, scheduler, hangups, conversation } = hangupSetup();
    conversation.userTurn('book it');
    await flushMicrotasks();
    adapter.channels[0]!.push(toolStart);
    await flushMicrotasks();
    conversation.userTurn('and a cab');
    adapter.channels[0]!.text('Booked. ⟪hangup⟫');
    adapter.channels[0]!.done();
    await flushMicrotasks();
    conversation.speechState('gen_1', 'playing');
    conversation.speechState('gen_1', 'finished');
    await flushMicrotasks();
    scheduler.advance(AGENT_HANGUP_LINGER_MS * 2);
    expect(hangups.count).toBe(0);
    adapter.channels[1]!.text('Cab booked too. ⟪hangup⟫');
    adapter.channels[1]!.done();
    await flushMicrotasks();
    conversation.speechState('gen_2', 'playing');
    conversation.speechState('gen_2', 'finished');
    scheduler.advance(AGENT_HANGUP_LINGER_MS);
    expect(hangups.count).toBe(1);
  });

  it('a late done from the turn a stop request cancelled sends nothing more', async () => {
    const { adapter, conversation, first } = await working('and zip them');
    conversation.userTurn('cancel');
    await flushMicrotasks();
    first.done();
    await flushMicrotasks();
    // The stop itself is never sent (ADR-028).
    expect(adapter.channels.map((c) => c.turn.text)).toEqual(['check the build']);
  });

  it('close while a queue waits behind the owner’s speech: nothing is sent', async () => {
    const { adapter, conversation, first, logger } = await working('and the tests');
    conversation.userSpeechStarted();
    first.done();
    await flushMicrotasks();
    conversation.close();
    conversation.userSpeechDiscarded();
    conversation.userTurn('late words');
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(1);
    expect(fields(logger, 'queued_turn_dropped')).toEqual([
      expect.objectContaining({ reason: 'call_ended' }),
    ]);
  });
});

describe('ConversationController presence cues while the agent works (ADR-028)', () => {
  const toolStart = {
    type: 'tool.start',
    tool_call_id: 't',
    tool_name: 'shell.exec',
    display_label: 'Running a command…',
  } as const;
  const fields = (logger: ReturnType<typeof recordingLogger>, event: string) =>
    logger.events.filter((e) => e.fields.event === event).map((e) => e.fields);

  class ToneSpeech extends RecordingSpeech {
    tones = 0;
    playTone(): void {
      this.tones += 1;
    }
  }

  function presence(options: { presenceCues?: boolean; agentName?: string } = {}) {
    const adapter = new ScriptedAdapter();
    const speech = new ToneSpeech();
    const scheduler = new ManualScheduler();
    const logger = recordingLogger();
    const conversation = new ConversationController({
      callId: CALL_ID,
      adapter,
      speech,
      scheduler,
      logger,
      send: () => undefined,
      wallClock: () => Date.UTC(2026, 8, 26, 12, 0, 0),
      presenceCues: options.presenceCues ?? true,
      agentName: options.agentName ?? 'Hermes',
    });
    const lines = () =>
      speech.calls.filter((c) => /^append gen_\d+ (Still working|Okay, stopped)/.test(c));
    return { adapter, speech, scheduler, logger, conversation, lines };
  }

  async function committed(p = presence(), text = 'check the build') {
    p.conversation.userSpeechStarted();
    p.conversation.userTurn(text);
    await flushMicrotasks();
    return { ...p, agent: p.adapter.channels.at(-1)! };
  }

  /** Lets the line just started play out. */
  function playOut(p: { conversation: ConversationController; speech: RecordingSpeech }): void {
    const id = /begin (gen_\d+)/.exec(
      p.speech.calls.filter((c) => c.startsWith('begin')).at(-1)!,
    )![1]!;
    p.conversation.speechState(id, 'playing');
    p.conversation.speechState(id, 'finished');
  }

  it('names every number', () => {
    expect(PRESENCE_TONE_AFTER_MS).toBe(700);
    expect(PROGRESS_LINE_AFTER_MS).toBe(4_000);
    expect(PROGRESS_LINE_REPEAT_MS).toBe(15_000);
    expect(MAX_PROGRESS_LINES).toBe(4);
    expect(OPENING_TURN_QUIET_MS).toBe(2_000);
    expect(MAX_STOP_REQUEST_WORDS).toBe(6);
  });

  it('plays the tone once, 700 ms after the commit, when the agent has said nothing', async () => {
    const { scheduler, speech, logger } = await committed();
    scheduler.advance(PRESENCE_TONE_AFTER_MS - 1);
    expect(speech.tones).toBe(0);
    scheduler.advance(1);
    expect(speech.tones).toBe(1);
    expect(fields(logger, 'presence_tone')).toEqual([
      expect.objectContaining({ turn_id: 'turn_1' }),
    ]);
    scheduler.advance(PROGRESS_LINE_AFTER_MS);
    expect(speech.tones).toBe(1);
  });

  it('plays no tone when the agent’s text comes first', async () => {
    const { scheduler, speech, agent } = await committed();
    scheduler.advance(300);
    agent.text('Sure. ');
    await flushMicrotasks();
    scheduler.advance(PRESENCE_TONE_AFTER_MS);
    expect(speech.tones).toBe(0);
  });

  it('plays no tone while the owner is speaking', async () => {
    const { scheduler, speech, conversation, logger } = await committed();
    conversation.userSpeechStarted();
    scheduler.advance(PRESENCE_TONE_AFTER_MS);
    expect(speech.tones).toBe(0);
    expect(logger.names()).not.toContain('presence_tone');
  });

  it('plays no tone for a queued turn or an answered ring’s opening turn', async () => {
    const p = presence();
    p.conversation.openingTurn('The owner answered; greet them.');
    await flushMicrotasks();
    p.scheduler.advance(PRESENCE_TONE_AFTER_MS);
    expect(p.speech.tones).toBe(0);
  });

  it('speaks one generic line after 12 s of silence, never sent to the agent', async () => {
    const { scheduler, speech, logger, lines, adapter, conversation } = await committed();
    scheduler.advance(PROGRESS_LINE_AFTER_MS);
    expect(lines()).toEqual([]);
    scheduler.advance(GENERIC_PROGRESS_LINE_AFTER_MS - PROGRESS_LINE_AFTER_MS - 1);
    expect(lines()).toEqual([]);
    scheduler.advance(1);
    expect(lines()).toEqual([`append gen_1 ${GENERIC_PROGRESS_LINE}`]);
    expect(GENERIC_PROGRESS_LINE).toBe('Still working on it.');
    expect(speech.calls).toContain('end gen_1');
    expect(fields(logger, 'progress_line')).toEqual([
      expect.objectContaining({ turn_id: 'turn_1', label_kind: 'generic', line: 1 }),
    ]);
    expect(adapter.channels).toHaveLength(1);
    expect(conversation.usage()).toMatchObject({ turns: 1, completed: 0, bargeIns: 0 });
  });

  it('says what the agent is really doing when its label is safe to speak', async () => {
    const p = await committed();
    p.agent.push(toolStart);
    await flushMicrotasks();
    p.scheduler.advance(PROGRESS_LINE_AFTER_MS);
    expect(p.lines()).toEqual(['append gen_1 Still working: running a command.']);
    expect(fields(p.logger, 'progress_line')[0]).toMatchObject({ label_kind: 'tool' });
  });

  it('falls back to the generic line for unsafe labels and once a tool ended', () => {
    expect(progressLine('Searching the web…')).toBe('Still working: searching the web.');
    expect(progressLine('NPM install')).toBe('Still working: NPM install.');
    for (const label of [
      undefined,
      'Working…',
      'shell.exec',
      'run_command',
      'getWeather',
      '50% done',
      'Almost done',
      'Step 3 of 4',
      '<b>Deleting</b> files',
      'Reading /etc/passwd',
      'x'.repeat(MAX_SPOKEN_LABEL_CHARS + 1),
    ]) {
      expect(progressLine(label), String(label)).toBe(GENERIC_PROGRESS_LINE);
    }
    expect(spokenActivityLabel('Searching…')).toBe('searching');
  });

  it('a tool end leaves only the generic line', async () => {
    const p = await committed();
    p.agent.push(toolStart);
    p.agent.push({ type: 'tool.end', tool_call_id: 't', status: 'success' });
    await flushMicrotasks();
    p.scheduler.advance(PROGRESS_LINE_AFTER_MS);
    expect(p.lines()).toEqual([]);
    p.scheduler.advance(GENERIC_PROGRESS_LINE_AFTER_MS - PROGRESS_LINE_AFTER_MS);
    expect(p.lines()).toEqual([`append gen_1 ${GENERIC_PROGRESS_LINE}`]);
  });

  it('speaks the generic line only once during a long silent turn', async () => {
    const p = await committed();
    let played = false;
    for (let t = 0; t < 120_000; t += 500) {
      // A quiet agent keeps its turn alive with events that carry no label or text.
      if (t % 10_000 === 0) p.agent.push({ type: 'run.started' });
      await flushMicrotasks();
      p.scheduler.advance(500);
      if (p.lines().length === 1 && !played) {
        playOut(p);
        played = true;
      }
    }
    expect(p.lines()).toEqual([`append gen_1 ${GENERIC_PROGRESS_LINE}`]);
    expect(fields(p.logger, 'progress_line')).toHaveLength(1);
  });

  it('speaks a new specific label after a different one', async () => {
    const p = await committed();
    p.agent.push({ type: 'activity', label: 'Running a command' });
    await flushMicrotasks();
    p.scheduler.advance(PROGRESS_LINE_AFTER_MS);
    playOut(p);
    p.agent.push({ type: 'activity', label: 'Working…' });
    await flushMicrotasks();
    p.scheduler.advance(PROGRESS_LINE_REPEAT_MS);
    expect(p.lines()).toEqual(['append gen_1 Still working: running a command.']);
    p.agent.push({ type: 'activity', label: 'Reading a web page' });
    await flushMicrotasks();
    p.scheduler.advance(PROGRESS_LINE_REPEAT_MS);
    expect(p.lines()).toEqual([
      'append gen_1 Still working: running a command.',
      'append gen_2 Still working: reading a web page.',
    ]);
    expect(fields(p.logger, 'progress_line').map((f) => f.label_kind)).toEqual([
      'activity',
      'activity',
    ]);
  });

  it('does not repeat an unchanged spoken label', async () => {
    const p = await committed();
    p.agent.push({ type: 'activity', label: 'Running a command' });
    await flushMicrotasks();
    p.scheduler.advance(PROGRESS_LINE_AFTER_MS);
    playOut(p);
    p.agent.push({ type: 'activity', label: 'Running a command…' });
    await flushMicrotasks();
    p.scheduler.advance(PROGRESS_LINE_REPEAT_MS);
    p.agent.push({ type: 'activity', label: 'Running a command' });
    await flushMicrotasks();
    p.scheduler.advance(PROGRESS_LINE_REPEAT_MS);
    expect(p.lines()).toEqual(['append gen_1 Still working: running a command.']);
    expect(fields(p.logger, 'progress_line')).toHaveLength(1);
  });

  it('speaks a specific label after one generic line', async () => {
    const p = await committed();
    // A working agent reports it started, as real ones do (the first-event timeout is 20 s).
    p.agent.push({ type: 'run.started' });
    await flushMicrotasks();
    p.scheduler.advance(GENERIC_PROGRESS_LINE_AFTER_MS);
    playOut(p);
    p.scheduler.advance(PROGRESS_LINE_REPEAT_MS);
    expect(p.lines()).toEqual([`append gen_1 ${GENERIC_PROGRESS_LINE}`]);
    p.agent.push({ type: 'activity', label: 'Reading a web page' });
    await flushMicrotasks();
    p.scheduler.advance(PROGRESS_LINE_REPEAT_MS);
    expect(p.lines()).toEqual([
      `append gen_1 ${GENERIC_PROGRESS_LINE}`,
      'append gen_2 Still working: reading a web page.',
    ]);
    expect(fields(p.logger, 'progress_line').map((f) => f.label_kind)).toEqual([
      'generic',
      'activity',
    ]);
  });

  it('keeps the 15 s gap and 4-line cap with many different labels', async () => {
    const p = await committed();
    const at: number[] = [];
    for (let i = 0; i < MAX_PROGRESS_LINES + 2; i += 1) {
      p.agent.push({
        type: 'activity',
        label: `Checking ${['build', 'tests', 'logs', 'deploy', 'status', 'queue'][i]}`,
      });
      await flushMicrotasks();
      p.scheduler.advance(i === 0 ? PROGRESS_LINE_AFTER_MS : PROGRESS_LINE_REPEAT_MS);
      if (p.lines().length > at.length) {
        at.push(p.scheduler.now());
        playOut(p);
      }
    }
    expect(at).toEqual([4_000, 19_000, 34_000, 49_000]);
    expect(p.lines()).toHaveLength(MAX_PROGRESS_LINES);
  });

  it('counts the 4 s from the agent’s last text and from the end of its speech', async () => {
    const p = await committed();
    p.agent.text('Let me check. ');
    p.agent.push(toolStart);
    await flushMicrotasks();
    p.conversation.speechState('gen_1', 'playing');
    p.scheduler.advance(6_000);
    expect(p.lines()).toEqual([]); // the preamble is still playing
    p.conversation.speechState('gen_1', 'finished');
    p.scheduler.advance(PROGRESS_LINE_AFTER_MS - 1);
    expect(p.lines()).toEqual([]);
    p.scheduler.advance(1);
    expect(p.lines()).toEqual(['append gen_2 Still working: running a command.']);
  });

  it('the owner talking over a line stops it; the turn keeps working and still answers', async () => {
    const p = await committed();
    p.agent.push(toolStart);
    await flushMicrotasks();
    p.scheduler.advance(PROGRESS_LINE_AFTER_MS);
    p.conversation.speechState('gen_1', 'playing');
    p.conversation.userSpeechStarted();
    p.conversation.userPartial('and also the tests');
    expect(p.speech.calls.at(-1)).toBe('cancel barge_in');
    expect(fields(p.logger, 'presence_cue_cut')).toEqual([
      expect.objectContaining({ kind: 'progress', reason: 'barge_in' }),
    ]);
    expect(p.agent.signal.aborted).toBe(false);
    expect(p.conversation.usage().bargeIns).toBe(0);
    p.conversation.userSpeechDiscarded();
    p.agent.text('All green.');
    p.agent.done();
    await flushMicrotasks();
    expect(p.speech.calls.filter((c) => c.startsWith('append gen_2')).join('')).toContain('green');
  });

  it('the agent’s text cuts a line in progress and starts at once, never overlapping', async () => {
    const p = await committed();
    p.scheduler.advance(GENERIC_PROGRESS_LINE_AFTER_MS);
    p.conversation.speechState('gen_1', 'playing');
    p.agent.text('The build is green.');
    await flushMicrotasks();
    const at = p.speech.calls.indexOf('cancel superseded');
    expect(at).toBeGreaterThan(-1);
    expect(p.speech.calls.slice(at, at + 2)).toEqual(['cancel superseded', 'begin gen_2']);
  });

  it('a line about a turn that finishes without text is cut', async () => {
    const p = await committed();
    p.scheduler.advance(GENERIC_PROGRESS_LINE_AFTER_MS);
    p.agent.done();
    await flushMicrotasks();
    expect(fields(p.logger, 'presence_cue_cut')).toEqual([
      expect.objectContaining({ kind: 'progress', reason: 'superseded' }),
    ]);
  });

  it('recognises natural stop phrasings, with the agent’s name, and nothing longer', () => {
    for (const text of [
      'Hermes, stop',
      'please stop',
      'No, cancel.',
      'okay just stop',
      'Hey Hermes, stop it please',
      'stop, please, stop',
      'Ok wait',
    ]) {
      expect(isStopRequest(text, 'Hermes'), text).toBe(true);
    }
    for (const text of [
      'stop the build after tests',
      'please',
      'Hermes',
      'no',
      'hey Hermes',
      'please please please please please please stop',
      'Hermes stop the deploy',
      'no wait for the tests',
    ]) {
      expect(isStopRequest(text, 'Hermes'), text).toBe(false);
    }
    expect(isStopRequest('Hermes, stop')).toBe(false);
    expect(isStopRequest('Laptop Claude, stop', 'Laptop Claude')).toBe(true);
  });

  for (const withTool of [false, true]) {
    it(`"Hermes, stop" in a long wait cancels the turn ${withTool ? 'with' : 'without'} tools and says "Okay, stopped."`, async () => {
      const p = await committed();
      if (withTool) p.agent.push(toolStart);
      await flushMicrotasks();
      p.scheduler.advance(withTool ? PROGRESS_LINE_AFTER_MS : GENERIC_PROGRESS_LINE_AFTER_MS);
      p.conversation.speechState('gen_1', 'playing');
      p.conversation.userSpeechStarted();
      p.conversation.userTurn('Hermes, stop.');
      await flushMicrotasks();
      expect(p.agent.signal.aborted).toBe(true);
      expect(p.adapter.cancelled).toEqual(['turn_1']);
      // The line was silenced first, then Twring said it stopped. The agent got nothing new.
      expect(p.speech.calls).toContain('cancel barge_in');
      expect(p.lines()).toEqual([
        `append gen_1 ${withTool ? 'Still working: running a command.' : GENERIC_PROGRESS_LINE}`,
        `append gen_2 ${STOPPED_LINE}`,
      ]);
      expect(STOPPED_LINE).toBe('Okay, stopped.');
      expect(p.adapter.channels).toHaveLength(1);
      expect(fields(p.logger, 'agent_stop_requested')).toEqual([
        expect.objectContaining({ turn_id: 'turn_1', working: true, tool_started: withTool }),
      ]);
      // Nothing more is said about a turn that is gone.
      p.scheduler.advance(60_000);
      expect(p.lines()).toHaveLength(2);
      expect(p.conversation.usage().turns).toBe(1);
    });
  }

  it('"stop" with nothing playing still cancels at once', async () => {
    const p = await committed();
    p.scheduler.advance(1_000);
    p.conversation.userTurn('please stop');
    await flushMicrotasks();
    expect(p.adapter.cancelled).toEqual(['turn_1']);
    expect(p.lines()).toEqual([`append gen_1 ${STOPPED_LINE}`]);
    expect(p.adapter.channels).toHaveLength(1);
  });

  it('a long sentence with a stop word is not a stop', async () => {
    const p = await committed();
    p.agent.push(toolStart);
    await flushMicrotasks();
    p.conversation.userTurn('stop the build after tests');
    await flushMicrotasks();
    expect(p.adapter.cancelled).toEqual([]);
    expect(fields(p.logger, 'turn_queued')).toHaveLength(1);
  });

  it('the kill switch turns off both the tone and the lines', async () => {
    const p = await committed(presence({ presenceCues: false }));
    p.agent.push(toolStart);
    await flushMicrotasks();
    p.scheduler.advance(120_000);
    expect(p.speech.tones).toBe(0);
    expect(p.lines()).toEqual([]);
    expect(p.logger.names()).not.toContain('progress_line');
  });

  it('says nothing during the hang-up linger', async () => {
    const p = await committed();
    p.agent.text('Bye now. [[hangup]]');
    p.agent.done();
    await flushMicrotasks();
    p.conversation.speechState('gen_1', 'playing');
    p.conversation.speechState('gen_1', 'finished');
    expect(p.logger.names()).toContain('agent_hangup_requested');
    p.scheduler.advance(AGENT_HANGUP_LINGER_MS - 1);
    expect(p.lines()).toEqual([]);
    expect(p.speech.tones).toBe(0);
  });

  it('a queued turn handed off gets no tone and no line before its own long silence', async () => {
    const p = await committed();
    p.agent.push(toolStart);
    await flushMicrotasks();
    p.scheduler.advance(500);
    p.conversation.userTurn('and the tests');
    p.scheduler.advance(200); // the first turn’s tone
    expect(p.speech.tones).toBe(1);
    p.agent.text('Built.');
    p.agent.done();
    await flushMicrotasks();
    p.conversation.speechState('gen_1', 'playing');
    p.conversation.speechState('gen_1', 'finished');
    await flushMicrotasks();
    expect(p.adapter.channels).toHaveLength(2);
    p.scheduler.advance(GENERIC_PROGRESS_LINE_AFTER_MS - 1);
    expect(p.speech.tones).toBe(1);
    expect(p.lines()).toEqual([]);
    p.scheduler.advance(1);
    expect(fields(p.logger, 'progress_line')).toEqual([
      expect.objectContaining({ turn_id: 'turn_2' }),
    ]);
  });

  it('an answered ring’s opening turn stays quiet for its first 2 s', async () => {
    const p = presence();
    p.conversation.openingTurn('Greet the owner.');
    await flushMicrotasks();
    p.scheduler.advance(OPENING_TURN_QUIET_MS);
    expect(p.lines()).toEqual([]);
    p.scheduler.advance(GENERIC_PROGRESS_LINE_AFTER_MS - OPENING_TURN_QUIET_MS);
    expect(p.lines()).toHaveLength(1);
  });

  it('keeps per-turn timers bounded across a long wait', async () => {
    const p = await committed();
    p.agent.push(toolStart);
    await flushMicrotasks();
    for (let i = 0; i < 100; i += 1) {
      p.scheduler.advance(1_000);
      expect(p.conversation.retainedState().turnTimers).toBeLessThanOrEqual(5);
    }
  });
});

describe('ConversationController instant acknowledgement (ADR-032)', () => {
  const fields = (logger: ReturnType<typeof recordingLogger>, event: string) =>
    logger.events.filter((e) => e.fields.event === event).map((e) => e.fields);

  function ack(options: { acknowledge?: boolean; presenceCues?: boolean } = {}) {
    const adapter = new ScriptedAdapter();
    const speech = new RecordingSpeech();
    const scheduler = new ManualScheduler();
    const logger = recordingLogger();
    const conversation = new ConversationController({
      callId: CALL_ID,
      adapter,
      speech,
      scheduler,
      logger,
      send: () => undefined,
      wallClock: () => Date.UTC(2026, 8, 26, 12, 0, 0),
      presenceCues: options.presenceCues ?? true,
      acknowledge: options.acknowledge ?? true,
      agentName: 'Hermes',
    });
    const acks = () =>
      speech.calls.filter(
        (c) => c.startsWith('append ') && ACK_LINES.some((line) => c.endsWith(` ${line}`)),
      );
    return { adapter, speech, scheduler, logger, conversation, acks };
  }

  async function said(p = ack(), text = 'check the build') {
    p.conversation.userSpeechStarted();
    p.conversation.userTurn(text);
    await flushMicrotasks();
    return { ...p, agent: p.adapter.channels.at(-1)! };
  }

  function finish(p: { conversation: ConversationController }, id: string): void {
    p.conversation.speechState(id, 'playing');
    p.conversation.speechState(id, 'finished');
  }

  it('names its number and keeps every line short, plain and different', () => {
    expect(ACK_LINE_AFTER_MS).toBe(1_500);
    expect(ACK_LINES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ACK_LINES).size).toBe(ACK_LINES.length);
    for (const line of ACK_LINES) {
      expect(line.split(' ').length, line).toBeLessThanOrEqual(4);
      // Letters only (no digits or markup a voice could misread), one sentence.
      expect(line, line).toMatch(/^[A-Z][a-z]*(,? [a-z]+)+\.$/);
      expect(line, line).not.toMatch(/\b(done|almost|finished|checking|looking)\b/i);
    }
    for (let n = 0; n < 20; n += 1) expect(ackLine(n + 1)).not.toBe(ackLine(n));
    expect(ackLine(0)).toBe(ACK_LINES[0]);
  });

  it('speaks one short line 1.5 s after the owner’s turn while the agent says nothing', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS - 1);
    expect(p.acks()).toEqual([]);
    p.scheduler.advance(1);
    expect(p.acks()).toEqual([`append gen_1 ${ACK_LINES[0]}`]);
    expect(p.speech.calls).toContain('end gen_1');
    expect(fields(p.logger, 'ack_line')).toEqual([expect.objectContaining({ turn_id: 'turn_1' })]);
    // Twring's own words: never sent to the agent, never a turn.
    expect(p.adapter.channels).toHaveLength(1);
    expect(p.conversation.usage()).toMatchObject({ turns: 1, completed: 0, bargeIns: 0 });
  });

  it('stops the moment the agent’s first words arrive, and they play at once', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    p.agent.text('The build is green. ');
    await flushMicrotasks();
    const cut = p.speech.calls.indexOf('cancel superseded');
    expect(cut).toBeGreaterThan(-1);
    expect(p.speech.calls.indexOf('begin gen_2')).toBeGreaterThan(cut);
    expect(fields(p.logger, 'presence_cue_cut')).toEqual([
      expect.objectContaining({ kind: 'ack', reason: 'superseded' }),
    ]);
    expect(p.speech.calls.filter((c) => c.startsWith('append gen_2')).join('')).toContain(
      'build is green',
    );
  });

  it('says nothing when the agent answers first', async () => {
    const p = await said();
    p.scheduler.advance(1_000);
    p.agent.text('Sure. ');
    await flushMicrotasks();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    expect(p.acks()).toEqual([]);
    expect(p.logger.names()).not.toContain('ack_line');
  });

  it('still answers an agent that went straight to a tool without a word', async () => {
    const p = await said();
    p.agent.push({ type: 'tool.start', tool_call_id: 't', tool_name: 'search' });
    await flushMicrotasks();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    expect(p.acks()).toEqual([`append gen_1 ${ACK_LINES[0]}`]);
  });

  it('speaks once per turn, and the long-silence line still comes 12 s after it', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    finish(p, 'gen_1');
    p.scheduler.advance(GENERIC_PROGRESS_LINE_AFTER_MS);
    expect(p.speech.calls).toContain(`append gen_2 ${GENERIC_PROGRESS_LINE}`);
    finish(p, 'gen_2');
    p.scheduler.advance(60_000);
    expect(p.acks()).toEqual([`append gen_1 ${ACK_LINES[0]}`]);
    expect(fields(p.logger, 'ack_line')).toHaveLength(1);
  });

  it('never talks over the owner, and a missed moment is not made up later', async () => {
    const p = await said();
    p.scheduler.advance(1_000);
    p.conversation.userSpeechStarted();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    p.conversation.userSpeechDiscarded();
    p.scheduler.advance(2_000);
    expect(p.acks()).toEqual([]);
    expect(p.logger.names()).not.toContain('ack_line');
  });

  it('not for an answered ring’s opening turn', async () => {
    const p = ack();
    p.conversation.openingTurn('The owner answered; greet them.');
    await flushMicrotasks();
    p.scheduler.advance(ACK_LINE_AFTER_MS * 2);
    expect(p.acks()).toEqual([]);
  });

  it('not for a queued turn: the owner already heard one for the turn it waited behind', async () => {
    const p = await said();
    p.agent.push({ type: 'tool.start', tool_call_id: 't', tool_name: 'search' });
    await flushMicrotasks();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    finish(p, 'gen_1');
    p.conversation.userSpeechStarted();
    p.conversation.userTurn('and the tests');
    await flushMicrotasks();
    p.agent.push({ type: 'tool.end', tool_call_id: 't', status: 'success' });
    p.agent.done();
    await flushMicrotasks();
    expect(p.adapter.channels).toHaveLength(2);
    p.scheduler.advance(ACK_LINE_AFTER_MS * 2);
    expect(p.acks()).toHaveLength(1);
  });

  it('a turn that takes in an acknowledged one is not acknowledged again', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    finish(p, 'gen_1');
    p.conversation.userSpeechStarted();
    p.conversation.userTurn('and the tests too');
    await flushMicrotasks();
    expect(p.logger.names()).toContain('turn_merged');
    p.scheduler.advance(ACK_LINE_AFTER_MS * 2);
    expect(p.acks()).toHaveLength(1);
  });

  it('a turn that takes in one not acknowledged yet gets its line', async () => {
    const p = await said();
    p.scheduler.advance(1_000);
    p.conversation.userSpeechStarted();
    p.conversation.userTurn('and the tests too');
    await flushMicrotasks();
    expect(p.logger.names()).toContain('turn_merged');
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    expect(p.acks()).toEqual([`append gen_1 ${ACK_LINES[0]}`]);
    expect(fields(p.logger, 'ack_line')).toEqual([expect.objectContaining({ turn_id: 'turn_2' })]);
  });

  it('varies the line from one turn to the next', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    finish(p, 'gen_1');
    p.agent.text('Green. ');
    p.agent.done();
    await flushMicrotasks();
    finish(p, 'gen_2');
    const next = await said(p, 'and the tests');
    next.scheduler.advance(ACK_LINE_AFTER_MS);
    expect(next.acks()).toEqual([`append gen_1 ${ACK_LINES[0]}`, `append gen_3 ${ACK_LINES[1]}`]);
  });

  it('not while an approval waits for the owner’s answer', async () => {
    const p = await said();
    p.agent.push({
      type: 'approval.required',
      approval_id: 'apr_1',
      action: 'delete_files',
      title: 'Delete files',
    });
    await flushMicrotasks();
    finish(p, 'gen_1');
    p.scheduler.advance(ACK_LINE_AFTER_MS * 2);
    expect(p.acks()).toEqual([]);
  });

  it('is off unless switched on, and off with presence cues', async () => {
    for (const options of [{ acknowledge: false }, { presenceCues: false }]) {
      const p = await said(ack(options));
      p.scheduler.advance(ACK_LINE_AFTER_MS * 2);
      expect(p.acks(), JSON.stringify(options)).toEqual([]);
    }
  });
});

describe('ConversationController instant acknowledgement, review pass (ADR-032)', () => {
  const fields = (logger: ReturnType<typeof recordingLogger>, event: string) =>
    logger.events.filter((e) => e.fields.event === event).map((e) => e.fields);

  /** Records when each generation was said to start, as the pipeline times its first audio. */
  class TimedSpeech extends RecordingSpeech {
    readonly startedAt: (number | undefined)[] = [];
    override begin(committedAt?: number): string {
      this.startedAt.push(committedAt);
      return super.begin();
    }
  }

  async function said(text = 'check the build') {
    const adapter = new ScriptedAdapter();
    const speech = new TimedSpeech();
    const scheduler = new ManualScheduler();
    const logger = recordingLogger();
    const conversation = new ConversationController({
      callId: CALL_ID,
      adapter,
      speech,
      scheduler,
      logger,
      send: () => undefined,
      wallClock: () => Date.UTC(2026, 8, 26, 12, 0, 0),
      presenceCues: true,
      acknowledge: true,
      agentName: 'Hermes',
    });
    scheduler.advance(10_000);
    conversation.userSpeechStarted();
    conversation.userTurn(text);
    await flushMicrotasks();
    const acks = () =>
      speech.calls.filter(
        (c) => c.startsWith('append ') && ACK_LINES.some((line) => c.endsWith(` ${line}`)),
      );
    return {
      adapter,
      speech,
      scheduler,
      logger,
      conversation,
      acks,
      agent: adapter.channels.at(-1)!,
    };
  }

  it('no line is a stop-talking phrase, so its echo cannot pass for the owner asking to wait', () => {
    for (const line of ACK_LINES) {
      for (const words of FLOOR_CONTROL_WORDS) {
        expect(line.toLowerCase(), line).not.toContain(words);
      }
    }
  });

  it('is timed from when it starts, not from the owner’s turn, so first-audio numbers stay the agent’s', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    expect(p.speech.startedAt).toEqual([10_000 + ACK_LINE_AFTER_MS]);
    expect(fields(p.logger, 'ack_line')).toEqual([
      expect.objectContaining({ turn_id: 'turn_1', generation_id: 'gen_1' }),
    ]);
    p.agent.text('Green. ');
    await flushMicrotasks();
    // The agent's answer is still timed from the owner's turn.
    expect(p.speech.startedAt).toEqual([10_000 + ACK_LINE_AFTER_MS, 10_000]);
  });

  it('its echo a moment after it ends is dropped, not taken as the owner talking', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    p.conversation.speechState('gen_1', 'playing');
    p.conversation.speechState('gen_1', 'finished');
    p.scheduler.advance(ECHO_FINISHED_TAIL_MS + 300);
    p.conversation.userSpeechStarted();
    p.conversation.userTurn(ACK_LINES[0]!);
    await flushMicrotasks();
    expect(fields(p.logger, 'echo_rejected')).toEqual([
      expect.objectContaining({ phase: 'commit' }),
    ]);
    expect(p.adapter.channels).toHaveLength(1);
    expect(p.agent.signal.aborted).toBe(false);
    expect(p.logger.names()).not.toContain('agent_turn_superseded');
    // Well after the tail, the same words are the owner's.
    p.scheduler.advance(ECHO_TAIL_MS);
    p.conversation.userSpeechStarted();
    p.conversation.userTurn(ACK_LINES[0]!);
    await flushMicrotasks();
    expect(p.adapter.channels).toHaveLength(2);
  });

  it('the owner talking over it stops it; the turn keeps working and still answers', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    p.conversation.speechState('gen_1', 'playing');
    p.conversation.userSpeechStarted();
    p.conversation.userPartial('and also the tests');
    expect(p.speech.calls.at(-1)).toBe('cancel barge_in');
    expect(fields(p.logger, 'presence_cue_cut')).toEqual([
      expect.objectContaining({ kind: 'ack', reason: 'barge_in' }),
    ]);
    expect(p.agent.signal.aborted).toBe(false);
    expect(p.conversation.usage().bargeIns).toBe(0);
    p.conversation.userSpeechDiscarded();
    p.agent.text('All green.');
    p.agent.done();
    await flushMicrotasks();
    expect(p.speech.calls.filter((c) => c.startsWith('append gen_2')).join('')).toContain('green');
  });

  it('logs how much of a cut line was heard', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    p.conversation.speechState('gen_1', 'playing');
    p.speech.played.set('gen_1', 420);
    p.agent.text('Green. ');
    await flushMicrotasks();
    expect(fields(p.logger, 'presence_cue_cut')).toEqual([
      expect.objectContaining({ kind: 'ack', reason: 'superseded', played_ms: 420 }),
    ]);
  });

  it('a quick follow-up after an acknowledged, unanswered turn is not acknowledged again', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    p.conversation.speechState('gen_1', 'playing');
    p.conversation.speechState('gen_1', 'finished');
    // The agent reported an activity, so the follow-up is not merged with the first request.
    p.agent.push({ type: 'activity', label: 'Reading the logs' });
    await flushMicrotasks();
    p.scheduler.advance(ECHO_TAIL_MS + 1);
    p.conversation.userSpeechStarted();
    p.conversation.userTurn('and tell me about the tests');
    await flushMicrotasks();
    expect(p.logger.names()).toContain('turn_merge_skipped');
    expect(p.adapter.channels).toHaveLength(2);
    p.scheduler.advance(ACK_LINE_AFTER_MS * 2);
    expect(p.acks()).toHaveLength(1);
  });
});

describe('ConversationController calmer lines (ADR-032 amendment, 2026-10-24)', () => {
  const fields = (logger: ReturnType<typeof recordingLogger>, event: string) =>
    logger.events.filter((e) => e.fields.event === event).map((e) => e.fields);

  async function said(text = 'check the build') {
    const adapter = new ScriptedAdapter();
    const speech = new RecordingSpeech();
    const scheduler = new ManualScheduler();
    const logger = recordingLogger();
    const conversation = new ConversationController({
      callId: CALL_ID,
      adapter,
      speech,
      scheduler,
      logger,
      send: () => undefined,
      wallClock: () => Date.UTC(2026, 8, 26, 12, 0, 0),
      presenceCues: true,
      acknowledge: true,
      agentName: 'Hermes',
    });
    conversation.userSpeechStarted();
    conversation.userTurn(text);
    await flushMicrotasks();
    const lines = () =>
      speech.calls.filter((c) => /^append gen_\d+ (Still working|Okay, one moment)/.test(c));
    return { adapter, speech, scheduler, logger, conversation, lines, agent: adapter.channels[0]! };
  }

  function finish(p: { conversation: ConversationController }, id: string): void {
    p.conversation.speechState(id, 'playing');
    p.conversation.speechState(id, 'finished');
  }

  it('names its numbers', () => {
    expect(GENERIC_PROGRESS_LINE_AFTER_MS).toBe(12_000);
    expect(CUE_FINISH_GRACE_MS).toBe(500);
  });

  it('after "one moment", no "Still working on it" follows until a long silence', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    finish(p, 'gen_1');
    p.scheduler.advance(PROGRESS_LINE_AFTER_MS);
    expect(p.lines()).toEqual(['append gen_1 Okay, one moment.']);
    // Counted from the end of "one moment" (it ended at once here).
    p.scheduler.advance(GENERIC_PROGRESS_LINE_AFTER_MS - PROGRESS_LINE_AFTER_MS);
    expect(p.lines()).toEqual([
      'append gen_1 Okay, one moment.',
      `append gen_2 ${GENERIC_PROGRESS_LINE}`,
    ]);
  });

  it('a real activity is still said, 4 s after "one moment" ends', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    finish(p, 'gen_1');
    p.agent.push({
      type: 'tool.start',
      tool_call_id: 't',
      tool_name: 'shell.exec',
      display_label: 'Running a command…',
    });
    await flushMicrotasks();
    p.scheduler.advance(PROGRESS_LINE_AFTER_MS);
    expect(p.lines()).toEqual([
      'append gen_1 Okay, one moment.',
      'append gen_2 Still working: running a command.',
    ]);
  });

  it('an activity that starts after 4 s is said as soon as it starts', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    finish(p, 'gen_1');
    p.scheduler.advance(6_000 - ACK_LINE_AFTER_MS);
    expect(p.lines()).toHaveLength(1);
    p.agent.push({ type: 'activity', label: 'Reading the logs' });
    await flushMicrotasks();
    p.scheduler.advance(0);
    expect(p.lines().at(-1)).toBe('append gen_2 Still working: reading the logs.');
  });

  it('a line that is nearly done finishes, then the answer starts at once', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    p.conversation.speechState('gen_1', 'playing');
    p.speech.totals.set('gen_1', 1_000);
    p.speech.played.set('gen_1', 1_000 - CUE_FINISH_GRACE_MS + 100);
    p.agent.text('The build is green. ');
    await flushMicrotasks();
    expect(p.speech.calls).not.toContain('cancel superseded');
    expect(p.speech.calls).not.toContain('begin gen_2');
    p.conversation.speechState('gen_1', 'finished');
    expect(p.speech.calls).toContain('begin gen_2');
    expect(p.speech.calls.filter((c) => c.startsWith('append gen_2')).join('')).toContain(
      'build is green',
    );
    expect(fields(p.logger, 'presence_cue_cut')).toEqual([]);
  });

  it('a line far from done is still cut by the answer', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    p.conversation.speechState('gen_1', 'playing');
    p.speech.totals.set('gen_1', 1_000);
    p.speech.played.set('gen_1', 200);
    p.agent.text('The build is green. ');
    await flushMicrotasks();
    expect(p.speech.calls).toContain('cancel superseded');
    expect(p.speech.calls).toContain('begin gen_2');
  });

  it('the answer never waits long: a line that does not report its end is cut', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    p.conversation.speechState('gen_1', 'playing');
    p.speech.totals.set('gen_1', 1_000);
    p.speech.played.set('gen_1', 900);
    p.agent.text('The build is green. ');
    await flushMicrotasks();
    expect(p.speech.calls).not.toContain('begin gen_2');
    p.scheduler.advance(CUE_FINISH_GRACE_MS + 200);
    expect(p.speech.calls).toContain('cancel superseded');
    expect(p.speech.calls).toContain('begin gen_2');
  });

  it('an agent that finishes while the line ends still gets its answer heard', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    p.conversation.speechState('gen_1', 'playing');
    p.speech.totals.set('gen_1', 1_000);
    p.speech.played.set('gen_1', 800);
    p.agent.text('Green. ');
    p.agent.done();
    await flushMicrotasks();
    expect(p.speech.calls).not.toContain('begin gen_2');
    p.conversation.speechState('gen_1', 'finished');
    expect(p.speech.calls.filter((c) => c.startsWith('append gen_2')).join('')).toContain('Green');
    finish(p, 'gen_2');
    expect(p.conversation.usage()).toMatchObject({ completed: 1 });
  });

  it('an approval question asked while the answer waits is heard in full, never cut', async () => {
    const p = await said();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    p.conversation.speechState('gen_1', 'playing');
    p.speech.totals.set('gen_1', 1_000);
    p.speech.played.set('gen_1', 800);
    p.agent.text('I need to run this. ');
    await flushMicrotasks();
    p.agent.push({
      type: 'approval.required',
      approval_id: 'apr_1',
      action: 'run_command',
      title: 'Run the tests',
    });
    await flushMicrotasks();
    const prompt = p.speech.calls.find((c) => c.startsWith('append gen_2'))!;
    expect(prompt).toContain('Say yes or no');
    p.scheduler.advance(CUE_FINISH_GRACE_MS + 500);
    expect(fields(p.logger, 'presence_cue_cut').map((f) => f.kind)).toEqual(['ack']);
    // The question replaced the preamble, as it cuts an agent's speech that is already playing.
    expect(p.speech.calls.join(' ')).not.toContain('I need to run this');
  });

  it('after "one moment", a line about a real activity waits 4 s from the end of it', async () => {
    const p = await said();
    p.agent.push({
      type: 'tool.start',
      tool_call_id: 't',
      tool_name: 'shell.exec',
      display_label: 'Running a command…',
    });
    await flushMicrotasks();
    p.scheduler.advance(ACK_LINE_AFTER_MS);
    p.scheduler.advance(1_000);
    finish(p, 'gen_1'); // the line ends 2.5 s after the turn
    p.scheduler.advance(PROGRESS_LINE_AFTER_MS - 1);
    expect(p.lines()).toEqual(['append gen_1 Okay, one moment.']);
    p.scheduler.advance(1);
    expect(p.lines().at(-1)).toBe('append gen_2 Still working: running a command.');
  });
});
