import type { TwringAgentAdapter } from '@twring/agent-adapter';
import {
  MAX_STATUS_MESSAGE_BYTES,
  statusMessageSchema,
  type AgentEvent,
  type StatusMessage,
  type UserTurn,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { ManualScheduler, flushMicrotasks, recordingLogger } from '../calls/testing';

import {
  APPROVAL_DENIED_LINE,
  APPROVAL_REASK,
  APPROVAL_TIMEOUT_MS,
  approvalVoiceDecision,
} from './approvals';
import {
  AGENT_TIMEOUTS,
  ConversationController,
  isStopRequest,
  type ConversationOptions,
  type SpeechOutput,
} from './controller';
import { GENERIC_PROGRESS_LINE_AFTER_MS, STOPPED_LINE } from './presence';

// Verifier pass (ADR-029): timers, races, echo and agent-phrased approvals, voice rules.

const CALL_ID = 'call_aaaaaaaaaaaaaaaaaaaa';

/** One turn's event stream that a test feeds by hand. */
class Channel implements AsyncIterable<AgentEvent> {
  private readonly queue: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private error: Error | undefined;
  seq = 0;

  constructor(
    readonly turn: UserTurn,
    readonly signal: AbortSignal,
  ) {
    signal.addEventListener('abort', () => {
      this.error = new Error('aborted');
      this.wake?.();
    });
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

  approval(id: string, title = 'Run ls', action: 'run_command' | 'delete_files' = 'run_command') {
    this.push({ type: 'approval.required', approval_id: id, action, title });
  }

  keepAlive(): void {
    this.push({ type: 'activity', label: 'Working…' });
  }

  done(): void {
    this.push({ type: 'done', status: 'completed' });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.error !== undefined) throw this.error;
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
    approvals: true,
    conversationResume: false,
    serverInitiatedCalls: false,
  };
  readonly channels: Channel[] = [];
  readonly cancelled: string[] = [];
  readonly decisions: { turnId: string; id: string; decision: 'approve' | 'deny' }[] = [];

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
  decideApproval(turnId: string, id: string, decision: 'approve' | 'deny'): Promise<void> {
    this.decisions.push({ turnId, id, decision });
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Like the real VoicePipeline: `begin` silently cancels the generation in progress (no finished or
 * failed callback for it), and only the active generation accepts text.
 */
class PipelineLikeSpeech implements SpeechOutput {
  readonly calls: string[] = [];
  /** Text of each generation, by id. */
  readonly texts = new Map<string, string>();
  active: string | undefined;
  private n = 0;
  readonly played = new Map<string, number>();
  begin(): string {
    if (this.active !== undefined) this.calls.push(`replaced ${this.active}`);
    this.n += 1;
    const id = `gen_${this.n}`;
    this.active = id;
    this.texts.set(id, '');
    this.calls.push(`begin ${id}`);
    return id;
  }
  append(id: string, text: string): void {
    this.calls.push(`append ${id} ${text}`);
    if (this.active === id) this.texts.set(id, (this.texts.get(id) ?? '') + text);
  }
  end(id: string): void {
    this.calls.push(`end ${id}`);
  }
  cancel(reason: string): void {
    this.calls.push(`cancel ${reason}`);
    this.active = undefined;
  }
  callerOnsetAt(): number | undefined {
    return undefined;
  }
  playedMs(id: string): number {
    return this.played.get(id) ?? 0;
  }
  totalAudioMs(): number | undefined {
    return undefined;
  }
  /** Every text appended to any generation, as one string (what TTS was asked to say). */
  spoken(): string {
    return this.calls
      .filter((c) => c.startsWith('append '))
      .map((c) => c.split(' ').slice(2).join(' '))
      .join(' ');
  }
}

function setup(
  extra: Partial<Pick<ConversationOptions, 'agentName' | 'presenceCues' | 'timeouts'>> = {},
) {
  const adapter = new ScriptedAdapter();
  const speech = new PipelineLikeSpeech();
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
    wallClock: () => Date.UTC(2026, 9, 6, 12, 0, 0) + scheduler.now(),
    agentName: 'Hermes',
    ...extra,
  });
  const of = <T extends StatusMessage['type']>(type: T) =>
    sent.filter((m): m is Extract<StatusMessage, { type: T }> => m.type === type);
  const floors = () => of('floor').map((m) => m.floor);
  /** The pipeline reports a generation's playout state, as the real one does. */
  const play = (id: string, state: 'playing' | 'finished' | 'failed') => {
    if (state !== 'playing' && speech.active === id) speech.active = undefined;
    conversation.speechState(id, state);
  };
  /** A turn whose agent is working, and an approval pending in it. */
  const pending = async (id = 'apr_1', title?: string) => {
    conversation.userTurn('clean up the build folder');
    await flushMicrotasks();
    const channel = adapter.channels.at(-1)!;
    channel.approval(id, title);
    await flushMicrotasks();
    return channel;
  };
  return { adapter, speech, scheduler, logger, sent, conversation, of, floors, play, pending };
}

const promptOf = (speech: PipelineLikeSpeech) =>
  [...speech.texts.entries()].find(([, text]) => text.includes('wants to'))?.[0];

describe('approvals: the prompt and the agent speech it interrupts', () => {
  it('a reply after the approval is still spoken when the prompt cut the agent mid-playout', async () => {
    const { adapter, speech, conversation, play, floors } = setup();
    conversation.userTurn('clean up the build folder');
    await flushMicrotasks();
    const channel = adapter.channels[0]!;
    channel.text('Sure, I will remove the build folder now. ');
    await flushMicrotasks();
    play('gen_1', 'playing');
    // The agent asks while its sentence is still playing: the pipeline cancels it for the prompt.
    channel.approval('apr_1');
    await flushMicrotasks();
    const prompt = promptOf(speech)!;
    expect(prompt).toBeDefined();
    play(prompt, 'playing');
    play(prompt, 'finished');
    expect(conversation.resolveApproval('apr_1', 'approve', 'tap')).toBe(true);
    channel.text('Done, the build folder is gone.');
    channel.done();
    await flushMicrotasks();
    // The answer after the approval must reach TTS, and the turn must end.
    const reply = [...speech.texts.entries()].find(([, t]) => t.includes('build folder is gone'));
    expect(reply).toBeDefined();
    play(reply![0], 'playing');
    play(reply![0], 'finished');
    expect(floors().at(-1)).toBe('listening');
  });
});

describe('approvals: Twring lines never silently replace the agent speaking', () => {
  it('a tap deny while the agent talks skips the "I said no" line and the reply still ends', async () => {
    const { speech, conversation, play, floors, pending } = setup();
    const channel = await pending();
    const prompt = promptOf(speech)!;
    play(prompt, 'playing');
    // The agent talks while it waits (its words win over Twring's line).
    channel.text('While you decide, I am listing what is in there. ');
    await flushMicrotasks();
    const talking = speech.active!;
    play(talking, 'playing');
    expect(conversation.resolveApproval('apr_1', 'deny', 'tap')).toBe(true);
    expect(speech.calls).not.toContain(`replaced ${talking}`);
    channel.text('Okay, leaving it.');
    channel.done();
    await flushMicrotasks();
    play(talking, 'finished');
    expect(floors().at(-1)).toBe('listening');
  });
});

describe('approvals: who may answer', () => {
  it('an answer the owner started before the agent asked does not approve', async () => {
    const { adapter, conversation, scheduler, of } = setup();
    conversation.userTurn('clean up the build folder');
    await flushMicrotasks();
    const channel = adapter.channels[0]!;
    // The agent asked "shall I go on?" in its own words; the owner starts answering...
    scheduler.advance(1_000);
    conversation.userSpeechStarted();
    conversation.userPartial('yes');
    // ...and the agent's permission request for something else lands mid-answer.
    scheduler.advance(300);
    channel.approval('apr_1', 'rm -rf ~', 'delete_files');
    await flushMicrotasks();
    scheduler.advance(300);
    conversation.userTurn('yes');
    expect(adapter.decisions).toEqual([]);
    expect(of('approval_resolved')).toEqual([]);
    // A fresh answer after the prompt still counts.
    scheduler.advance(4_000);
    conversation.userSpeechStarted();
    conversation.userPartial('yes');
    conversation.userTurn('yes');
    expect(adapter.decisions).toEqual([{ turnId: 'turn_1', id: 'apr_1', decision: 'approve' }]);
  });

  it('echo of the prompt ("say yes or no") never answers', async () => {
    const { adapter, speech, conversation, scheduler, play, pending } = setup();
    await pending();
    const prompt = promptOf(speech)!;
    play(prompt, 'playing');
    speech.played.set(prompt, 3_500);
    scheduler.advance(3_500);
    for (const echo of ['yes', 'Say yes.', 'yes or no', 'no']) {
      conversation.userSpeechStarted();
      conversation.userPartial(echo);
      conversation.userTurn(echo);
    }
    expect(adapter.decisions).toEqual([]);
    expect(speech.spoken().split(APPROVAL_REASK)).toHaveLength(2);
  });

  it("echo of the agent's own 'yes' never answers", async () => {
    const { adapter, speech, conversation, scheduler, play } = setup();
    conversation.userTurn('clean up');
    await flushMicrotasks();
    const channel = adapter.channels[0]!;
    channel.text('Yes. Yes, okay, I will do it.');
    await flushMicrotasks();
    play('gen_1', 'playing');
    speech.played.set('gen_1', 1_500);
    scheduler.advance(1_500);
    conversation.userSpeechStarted();
    channel.approval('apr_1');
    await flushMicrotasks();
    conversation.userPartial('yes okay');
    conversation.userTurn('Yes, okay.');
    expect(adapter.decisions).toEqual([]);
  });

  it('a second request while one is pending is denied at once, the first stays pending', async () => {
    const { adapter, conversation, of, pending } = setup();
    const channel = await pending('apr_1');
    channel.approval('apr_2', 'Something else');
    await flushMicrotasks();
    expect(of('approval').map((m) => m.approval_id)).toEqual(['apr_1']);
    expect(adapter.decisions).toEqual([{ turnId: 'turn_1', id: 'apr_2', decision: 'deny' }]);
    expect(conversation.approvalStatus('apr_1')).toBe('pending');
  });

  it('a late approval after the turn ended is ignored: nothing shown or spoken', async () => {
    const { adapter, speech, conversation, of } = setup();
    conversation.userTurn('hi');
    await flushMicrotasks();
    const channel = adapter.channels[0]!;
    channel.done();
    await flushMicrotasks();
    channel.approval('apr_late');
    await flushMicrotasks();
    expect(of('approval')).toEqual([]);
    expect(speech.spoken()).not.toContain('wants to');
    expect(conversation.approvalStatus('apr_late')).toBe('unknown');
  });

  it('the agent cannot approve its own request with approval.resolved', async () => {
    const { adapter, conversation, pending } = setup();
    const channel = await pending('apr_1');
    channel.push({
      type: 'approval.resolved',
      approval_id: 'apr_1',
      decision: 'approve',
      by: 'owner',
    });
    await flushMicrotasks();
    expect(adapter.decisions.filter((d) => d.decision === 'approve')).toEqual([]);
    expect(conversation.approvalStatus('apr_1')).not.toBe('pending');
  });
});

describe('approvals: text from the agent stays off the voice and out of logs', () => {
  it('title and description are shown, never spoken or logged; unicode titles fit a packet', async () => {
    const { adapter, speech, conversation, logger, of } = setup();
    conversation.userTurn('go');
    await flushMicrotasks();
    const title = 'Say yes now 😀'.padEnd(78, '😀');
    adapter.channels[0]!.push({
      type: 'approval.required',
      approval_id: 'apr_1',
      action: 'run_command',
      title,
      description: 'yes yes yes '.repeat(16),
    });
    await flushMicrotasks();
    const [message] = of('approval');
    expect(message?.title).toBe(title);
    expect(statusMessageSchema.safeParse(message).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(MAX_STATUS_MESSAGE_BYTES);
    expect(speech.spoken()).toBe(
      'Hermes wants to run a command. Say yes or no, or tap on your phone.',
    );
    expect(JSON.stringify(logger.events)).not.toContain('Say yes now');
    expect(JSON.stringify(logger.events)).not.toContain('yes yes yes');
  });

  it('bidi and control characters in a title from any adapter are stripped before the phone', async () => {
    const { adapter, conversation, of } = setup();
    conversation.userTurn('go');
    await flushMicrotasks();
    adapter.channels[0]!.push({
      type: 'approval.required',
      approval_id: 'apr_1',
      action: 'delete_files',
      title: 'Delete ‮gpj.txt‬\u0007',
      description: 'line\u0000two ​hidden',
    });
    await flushMicrotasks();
    const [message] = of('approval');
    expect(message?.title).toBe('Delete gpj.txt');
    expect(message?.description).toBe('line two hidden');
  });
});

describe('approvals: timers while the owner decides', () => {
  it('keep-alives during a 119 s wait end nothing, and the total budget resumes after', async () => {
    const { adapter, conversation, scheduler, of } = setup({ timeouts: { totalMs: 180_000 } });
    conversation.userTurn('go');
    await flushMicrotasks();
    const channel = adapter.channels[0]!;
    // 100 s of quiet tool work before the agent asks (the connector's 10 s keep-alives).
    for (let i = 0; i < 10; i += 1) {
      scheduler.advance(10_000);
      channel.keepAlive();
      await flushMicrotasks();
    }
    channel.approval('apr_1');
    await flushMicrotasks();
    for (let i = 0; i < 11; i += 1) {
      scheduler.advance(10_000);
      channel.keepAlive();
      await flushMicrotasks();
    }
    scheduler.advance(9_000);
    expect(of('notice')).toEqual([]);
    expect(conversation.resolveApproval('apr_1', 'approve', 'tap')).toBe(true);
    // 80 s of the 180 s total remain: keep-alives keep idle away until the total ends the turn.
    for (let i = 0; i < 7; i += 1) {
      scheduler.advance(10_000);
      channel.keepAlive();
      await flushMicrotasks();
    }
    expect(of('notice')).toEqual([]);
    scheduler.advance(10_000);
    expect(of('notice').map((n) => n.code)).toEqual(['agent_timeout']);
  });

  it('a silent agent waiting on the owner is not idled out; idle resumes after the answer', async () => {
    const { conversation, scheduler, of, pending } = setup();
    await pending();
    scheduler.advance(APPROVAL_TIMEOUT_MS - 1);
    expect(of('notice')).toEqual([]);
    expect(conversation.resolveApproval('apr_1', 'deny', 'tap')).toBe(true);
    scheduler.advance(AGENT_TIMEOUTS.idleMs - 1);
    expect(of('notice')).toEqual([]);
    scheduler.advance(1);
    expect(of('notice').map((n) => n.code)).toEqual(['agent_timeout']);
  });

  it('no progress line talks over a pending approval; they resume after it', async () => {
    const { speech, conversation, scheduler, play, pending } = setup({ presenceCues: true });
    await pending();
    const prompt = promptOf(speech)!;
    play(prompt, 'playing');
    play(prompt, 'finished');
    scheduler.advance(APPROVAL_TIMEOUT_MS - 1);
    expect(speech.spoken()).not.toContain('Still');
    conversation.resolveApproval('apr_1', 'approve', 'tap');
    scheduler.advance(GENERIC_PROGRESS_LINE_AFTER_MS);
    expect(speech.spoken()).toContain('Still');
  });

  it('the approval timeout fires once at 120 s and a later tap is refused', async () => {
    const { adapter, conversation, scheduler, of, pending } = setup();
    await pending();
    scheduler.advance(APPROVAL_TIMEOUT_MS);
    expect(adapter.decisions).toEqual([{ turnId: 'turn_1', id: 'apr_1', decision: 'deny' }]);
    expect(conversation.resolveApproval('apr_1', 'approve', 'tap')).toBe(false);
    expect(conversation.approvalStatus('apr_1')).toBe('decided');
    expect(of('approval_resolved')).toHaveLength(1);
  });
});

describe('approvals: races', () => {
  it('a tap and a voice answer together: the first wins, the other changes nothing', async () => {
    const { adapter, conversation, of, pending } = setup();
    await pending();
    expect(conversation.resolveApproval('apr_1', 'deny', 'tap')).toBe(true);
    conversation.userTurn('yes');
    expect(adapter.decisions).toEqual([{ turnId: 'turn_1', id: 'apr_1', decision: 'deny' }]);
    expect(of('approval_resolved').map((m) => m.by)).toEqual(['tap']);
    // The late "yes" is an ordinary turn now: queued behind the working agent, never an approval.
    expect(adapter.channels).toHaveLength(1);
  });

  it('a decision for an old approval id does not touch the new one', async () => {
    const { adapter, conversation, pending } = setup();
    const channel = await pending('apr_1');
    conversation.resolveApproval('apr_1', 'deny', 'tap');
    channel.approval('apr_2');
    await flushMicrotasks();
    expect(conversation.resolveApproval('apr_1', 'approve', 'tap')).toBe(false);
    expect(conversation.approvalStatus('apr_2')).toBe('pending');
    expect(adapter.decisions.map((d) => d.id)).toEqual(['apr_1']);
  });

  it('an old id re-sent as a new request after it was decided is denied, not left hanging', async () => {
    const { adapter, conversation, pending } = setup();
    const channel = await pending('apr_1');
    conversation.resolveApproval('apr_1', 'approve', 'tap');
    channel.approval('apr_1');
    await flushMicrotasks();
    expect(adapter.decisions).toEqual([
      { turnId: 'turn_1', id: 'apr_1', decision: 'approve' },
      { turnId: 'turn_1', id: 'apr_1', decision: 'deny' },
    ]);
  });

  it('a barge-in over the prompt cuts it; a "nope" then denies', async () => {
    const { adapter, speech, conversation, scheduler, play, pending } = setup();
    await pending();
    const prompt = promptOf(speech)!;
    play(prompt, 'playing');
    speech.played.set(prompt, 800);
    scheduler.advance(800);
    conversation.userSpeechStarted();
    conversation.userPartial('nope');
    expect(speech.calls).toContain('cancel barge_in');
    conversation.userTurn('Nope.');
    expect(adapter.decisions).toEqual([{ turnId: 'turn_1', id: 'apr_1', decision: 'deny' }]);
  });

  it('call end at the moment of a tap: one deny, the tap is refused', async () => {
    const { adapter, conversation, of, pending } = setup();
    await pending();
    conversation.close();
    expect(conversation.resolveApproval('apr_1', 'approve', 'tap')).toBe(false);
    expect(adapter.decisions).toEqual([{ turnId: 'turn_1', id: 'apr_1', decision: 'deny' }]);
    expect(of('approval_resolved').map((m) => m.by)).toEqual(['call_end']);
  });

  it('the agent failing while pending denies once and the phone hears of it', async () => {
    const { adapter, conversation, of, pending } = setup();
    const channel = await pending();
    channel.push({ type: 'error', code: 'agent_failed', retryable: false });
    await flushMicrotasks();
    expect(adapter.decisions).toEqual([{ turnId: 'turn_1', id: 'apr_1', decision: 'deny' }]);
    expect(of('approval_resolved')).toHaveLength(1);
    expect(conversation.approvalStatus('apr_1')).toBe('decided');
  });

  it('the phone rejoining while an approval is pending gets the approval again', async () => {
    const { conversation, of, pending } = setup();
    await pending();
    conversation.resendFloor();
    expect(of('approval').map((m) => m.approval_id)).toEqual(['apr_1', 'apr_1']);
    conversation.resolveApproval('apr_1', 'deny', 'tap');
    conversation.resendFloor();
    expect(of('approval')).toHaveLength(2);
  });
});

describe('approvals: voice rules', () => {
  it.each([
    ['yes please', 'approve'],
    ['Hermes yes', 'approve'],
    ['Hermes, yes.', 'approve'],
    ['okay', 'approve'],
    ['OK!', 'approve'],
    ['YES', 'approve'],
    ['sure', 'approve'],
    ['no', 'deny'],
    ['Nope.', 'deny'],
    ['not now', 'deny'],
    ["don't", 'deny'],
    ['dont', 'deny'],
    ['no thanks', 'deny'],
    ['No, thank you.', 'deny'],
    ['yes no', undefined],
    ['no yes', undefined],
    ['do not do it', undefined],
    ['yes but delete only the logs', undefined],
    ['haan', undefined],
    ['illai', undefined],
    ['', undefined],
    ['Hermes', undefined],
    ['please', undefined],
  ] as const)('%j → %s', (text, decision) => {
    expect(approvalVoiceDecision(text, 'Hermes')).toBe(decision);
  });

  it.each(['stop', 'cancel that'])(
    '"%s" denies and cancels the turn, and says so',
    async (text) => {
      const { adapter, speech, conversation, of, pending } = setup();
      await pending();
      conversation.userTurn(text);
      expect(adapter.decisions).toEqual([{ turnId: 'turn_1', id: 'apr_1', decision: 'deny' }]);
      expect(adapter.cancelled).toEqual(['turn_1']);
      expect(of('approval_resolved').map((message) => message.by)).toEqual(['stop']);
      expect(speech.spoken()).toContain(STOPPED_LINE);
      expect(speech.spoken()).not.toContain(APPROVAL_DENIED_LINE);
    },
  );

  it.each(['hold on', 'wait', 'one second'])(
    '"%s" leaves the approval pending and re-asks at most once',
    async (text) => {
      const { adapter, speech, conversation, of, pending } = setup();
      await pending();
      conversation.userTurn(text);
      conversation.userTurn(text);
      expect(conversation.approvalStatus('apr_1')).toBe('pending');
      expect(adapter.decisions).toEqual([]);
      expect(adapter.cancelled).toEqual([]);
      expect(of('approval_resolved')).toEqual([]);
      expect(speech.spoken().split(APPROVAL_REASK)).toHaveLength(2);
    },
  );

  it('a new request waits behind the approval turn and is sent after it ends', async () => {
    const { adapter, speech, conversation, logger, of, pending } = setup();
    const channel = await pending();
    conversation.userTurn('also check the logs folder please');
    expect(conversation.approvalStatus('apr_1')).toBe('pending');
    expect(adapter.decisions).toEqual([]);
    expect(of('approval_resolved')).toEqual([]);
    expect(adapter.channels).toHaveLength(1);
    expect(logger.names()).toContain('turn_queued');
    expect(speech.spoken()).not.toContain(APPROVAL_REASK);
    channel.done();
    await flushMicrotasks();
    expect(adapter.channels).toHaveLength(2);
    expect(adapter.channels[1]!.turn.text).toBe('also check the logs folder please');
    expect(logger.names()).toContain('queued_turn_sent');
  });

  it('a long answer that opens with yes or no is re-asked, not queued or decided', async () => {
    const { adapter, speech, conversation, logger, of, pending } = setup();
    await pending();
    conversation.userTurn('yes go ahead and make the picture');
    expect(conversation.approvalStatus('apr_1')).toBe('pending');
    expect(adapter.decisions).toEqual([]);
    expect(of('approval_resolved')).toEqual([]);
    expect(logger.names()).not.toContain('turn_queued');
    expect(speech.spoken()).toContain(APPROVAL_REASK);
  });

  it('floor-holding words still count as stop requests outside approval handling', () => {
    for (const text of ['hold on', 'wait', 'one second', 'hang on'])
      expect(isStopRequest(text, 'Hermes')).toBe(true);
  });

  it('"wait" still cancels a working turn without an approval', async () => {
    const { adapter, conversation } = setup();
    conversation.userTurn('clean up the build folder');
    await flushMicrotasks();
    conversation.userTurn('wait');
    expect(adapter.cancelled).toEqual(['turn_1']);
  });

  it('unclear speech re-asks once and is never sent to the agent', async () => {
    const { adapter, speech, conversation, pending } = setup();
    await pending();
    conversation.userTurn('hmm');
    conversation.userTurn('maybe');
    conversation.userTurn('perhaps');
    expect(speech.spoken().split(APPROVAL_REASK)).toHaveLength(2);
    expect(adapter.channels).toHaveLength(1);
    expect(adapter.decisions).toEqual([]);
  });
});

describe('approvals: usage stays correct', () => {
  it('an approval adds no turns and the turn completes once', async () => {
    const { conversation, play, speech, pending } = setup();
    const channel = await pending();
    const prompt = promptOf(speech)!;
    play(prompt, 'playing');
    play(prompt, 'finished');
    conversation.userTurn('yes');
    channel.text('Done.');
    channel.done();
    await flushMicrotasks();
    const reply = [...speech.texts.entries()].find(([, t]) => t === 'Done.')![0];
    play(reply, 'playing');
    play(reply, 'finished');
    expect(conversation.usage()).toEqual({ turns: 1, completed: 1, failed: 0, bargeIns: 0 });
  });
});

describe('approvals: echo safety has a cost', () => {
  it('a "yes" rejected as prompt echo re-asks once without deciding', async () => {
    const { adapter, speech, conversation, scheduler, play, pending, logger } = setup();
    await pending();
    const prompt = promptOf(speech)!;
    play(prompt, 'playing');
    speech.played.set(prompt, 4_600);
    scheduler.advance(4_600);
    conversation.userSpeechStarted();
    play(prompt, 'finished');
    scheduler.advance(300);
    conversation.userPartial('yes');
    conversation.userTurn('Yes.');
    conversation.userSpeechStarted();
    conversation.userPartial('yes');
    conversation.userTurn('Yes.');
    expect(adapter.decisions).toEqual([]);
    expect(conversation.approvalStatus('apr_1')).toBe('pending');
    expect(logger.names()).toContain('echo_rejected');
    expect(logger.names().filter((name) => name === 'approval_reask_after_echo')).toHaveLength(1);
    expect(speech.spoken().split(APPROVAL_REASK)).toHaveLength(2);
  });
});
