import { type TwringAgentAdapter } from '@twring/agent-adapter';
import {
  AGENT_HANGUP_LINGER_MS,
  STAY_ON_CALL_RULE,
  answeredTurnText,
  type AgentEvent,
  type StatusMessage,
  type UserTurn,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { ManualScheduler, flushMicrotasks, recordingLogger } from '../calls/testing';

import {
  stripHangupMarkers,
  ConversationController,
  type ConversationOptions,
  type SpeechOutput,
} from './controller';

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
) {
  const speech = new RecordingSpeech();
  const scheduler = new ManualScheduler();
  const logger = recordingLogger();
  const sent: StatusMessage[] = [];
  const hangups: number[] = [];
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
    onAgentHangup: () => hangups.push(1),
  });
  const floors = () =>
    sent.flatMap((m) =>
      m.type === 'floor' ? [m.floor + (m.activity !== undefined ? `(${m.activity})` : '')] : [],
    );
  const of = <T extends StatusMessage['type']>(type: T) =>
    sent.filter((m): m is Extract<StatusMessage, { type: T }> => m.type === type);
  return { adapter, speech, scheduler, logger, sent, conversation, floors, of, hangups };
}

/** The agent's hang-up marker and the opening turn of an answered ring (ADR-024). */

async function hangupReply(t: ReturnType<typeof setup>, parts: string[]) {
  t.conversation.userTurn('bye then');
  await flushMicrotasks();
  const agent = t.adapter.channels.at(-1)!;
  for (const part of parts) agent.text(part);
  agent.done();
  await flushMicrotasks();
}

describe('hang-up marker', () => {
  it('strips markers, including one split across deltas, and keeps look-alike text', () => {
    expect(stripHangupMarkers('Bye now. ⟪hangup⟫', true)).toEqual({
      text: 'Bye now. ',
      carry: '',
      found: true,
    });
    expect(stripHangupMarkers('ok [[hang', false)).toEqual({
      text: 'ok ',
      carry: '[[hang',
      found: false,
    });
    expect(stripHangupMarkers('[[hangup]] done', false).text).toBe(' done');
    expect(stripHangupMarkers('a [[b', true).text).toBe('a [[b');
  });

  it('never speaks the marker, and ends the call after the linger when the owner stays quiet', async () => {
    const t = setup();
    await hangupReply(t, ['Talk soon. [[hang', 'up]]']);
    expect(t.speech.calls.join('|')).not.toContain('hangup');
    expect(t.of('agent_text').at(-1)?.text).not.toContain('hangup');
    t.conversation.speechState('gen_1', 'playing');
    t.conversation.speechState('gen_1', 'finished');
    t.scheduler.advance(AGENT_HANGUP_LINGER_MS - 1);
    expect(t.hangups).toEqual([]);
    t.scheduler.advance(1);
    expect(t.hangups).toEqual([1]);
  });

  it('owner speech in the lingering window cancels the hang-up', async () => {
    const t = setup();
    await hangupReply(t, ['Bye. ⟪hangup⟫']);
    t.conversation.speechState('gen_1', 'playing');
    t.conversation.speechState('gen_1', 'finished');
    t.scheduler.advance(3_000);
    t.conversation.userSpeechStarted();
    t.scheduler.advance(AGENT_HANGUP_LINGER_MS * 2);
    expect(t.hangups).toEqual([]);
  });

  it('a reply the owner barged into does not hang up', async () => {
    const t = setup();
    await hangupReply(t, ['Bye. [[hangup]]']);
    t.conversation.speechState('gen_1', 'playing');
    t.conversation.userSpeechStarted();
    t.conversation.userTurn('wait, one more thing');
    await flushMicrotasks();
    t.scheduler.advance(AGENT_HANGUP_LINGER_MS * 2);
    expect(t.hangups).toEqual([]);
  });

  it('the opening turn goes to the agent first, and only once', async () => {
    const t = setup();
    const text = answeredTurnText('The build failed');
    t.conversation.openingTurn(text);
    t.conversation.openingTurn(text);
    await flushMicrotasks();
    expect(t.adapter.channels.map((c) => c.turn.text)).toEqual([
      `[The owner answered your call. You rang because: The build failed. Tell them, then let them talk. ${STAY_ON_CALL_RULE}]`,
    ]);
  });
});

describe('hang-up marker edge cases (verifier)', () => {
  const spokenText = (t: ReturnType<typeof setup>) =>
    t.speech.calls
      .filter((c) => c.startsWith('append'))
      .map((c) => c.replace(/^append gen_\d+ /, ''))
      .join('');

  it('does not hang up on an owner who is already talking when the reply ends', async () => {
    const t = setup();
    await hangupReply(t, ['Bye. ⟪hangup⟫']);
    t.conversation.speechState('gen_1', 'playing');
    // The owner starts over the tail of the reply; the barge-in is still pending (not yet proven
    // not to be echo) when the reply finishes playing.
    t.conversation.userSpeechStarted();
    t.conversation.speechState('gen_1', 'finished');
    // They keep talking longer than the linger; their turn only commits at the end.
    t.scheduler.advance(AGENT_HANGUP_LINGER_MS + 2_000);
    expect(t.hangups).toEqual([]);
    t.conversation.userTurn('actually, one more thing before you go');
    await flushMicrotasks();
    expect(t.adapter.channels).toHaveLength(2);
  });

  it('a deferred hang-up starts its window once the owner speech turns out to be noise', async () => {
    const t = setup();
    await hangupReply(t, ['Bye. ⟪hangup⟫']);
    t.conversation.speechState('gen_1', 'playing');
    t.conversation.userSpeechStarted();
    t.conversation.speechState('gen_1', 'finished');
    t.scheduler.advance(2_000);
    t.conversation.userSpeechDiscarded();
    t.scheduler.advance(AGENT_HANGUP_LINGER_MS - 1);
    expect(t.hangups).toEqual([]);
    t.scheduler.advance(1);
    expect(t.hangups).toEqual([1]);
  });

  it('a marker split one character at a time is still stripped and honoured', async () => {
    const t = setup();
    await hangupReply(t, ['Bye', ...Array.from('⟪hangup⟫')]);
    expect(t.speech.calls.join('|')).not.toMatch(/[⟪⟫]|hangup/);
    t.conversation.speechState('gen_1', 'playing');
    t.conversation.speechState('gen_1', 'finished');
    t.scheduler.advance(AGENT_HANGUP_LINGER_MS);
    expect(t.hangups).toEqual([1]);
  });

  it('matches the marker in any letter case, even split across deltas', async () => {
    expect(stripHangupMarkers('Bye ⟪HANGUP⟫', true)).toEqual({
      text: 'Bye ',
      carry: '',
      found: true,
    });
    expect(stripHangupMarkers('ok [[HangUp]] x', false).text).toBe('ok  x');
    expect(stripHangupMarkers('ok [[HAN', false).carry).toBe('[[HAN');
    const t = setup();
    await hangupReply(t, ['Talk soon. ⟪HAN', 'gUp⟫']);
    expect(spokenText(t)).not.toMatch(/[⟪⟫]|hangup/i);
    t.conversation.speechState('gen_1', 'playing');
    t.conversation.speechState('gen_1', 'finished');
    t.scheduler.advance(AGENT_HANGUP_LINGER_MS);
    expect(t.hangups).toEqual([1]);
  });

  it('a marker inside a sentence is stripped and the rest is spoken', async () => {
    const t = setup();
    await hangupReply(t, ['Okay [[hang', 'up]] talk soon.']);
    expect(spokenText(t)).not.toContain('hangup');
    expect(spokenText(t)).toContain('talk soon.');
  });

  it('look-alike text held back at a delta boundary is released, not lost', async () => {
    const t = setup();
    await hangupReply(t, ['See [[', 'b]] and ⟪h', 'ello⟫']);
    expect(spokenText(t)).toContain('[[b]]');
    expect(t.of('agent_text').at(-1)?.text).toContain('⟪hello⟫');
    t.conversation.speechState('gen_1', 'playing');
    t.conversation.speechState('gen_1', 'finished');
    t.scheduler.advance(AGENT_HANGUP_LINGER_MS * 2);
    expect(t.hangups).toEqual([]);
  });

  it('a reply that is only the marker hangs up after the linger', async () => {
    const t = setup();
    await hangupReply(t, ['⟪hangup⟫']);
    expect(spokenText(t)).toBe('');
    t.scheduler.advance(AGENT_HANGUP_LINGER_MS);
    expect(t.hangups).toEqual([1]);
  });

  it('the linger timer does not fire after the call closed', async () => {
    const t = setup();
    await hangupReply(t, ['Bye. ⟪hangup⟫']);
    t.conversation.speechState('gen_1', 'playing');
    t.conversation.speechState('gen_1', 'finished');
    t.conversation.close();
    t.scheduler.advance(AGENT_HANGUP_LINGER_MS * 2);
    expect(t.hangups).toEqual([]);
  });
});
