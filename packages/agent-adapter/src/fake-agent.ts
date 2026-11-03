import type { AdapterCapabilities, AgentEvent, UserTurn } from '@twring/contracts';

import { systemSleep, type TwringAgentAdapter, type Sleep } from './adapter';

export interface FakeAgentOptions {
  /** Delay before the first event, like a model's time to first token. */
  thinkMs?: number;
  /** Delay between text deltas. */
  deltaMs?: number;
  /** How long the pretend tool call takes. */
  toolMs?: number;
  sleep?: Sleep;
}

/** A scripted reply: optional pretend tool work, then text. */
interface Script {
  tool?: { name: string; label: string };
  text: string;
  /** End the turn with an agent error instead of `done` (after any text). */
  fail?: boolean;
  /** Never answer: lets the caller exercise Twring's agent timeouts. */
  silent?: boolean;
}

const CAPABILITIES: AdapterCapabilities = {
  streamingText: true,
  cancellation: true,
  resumableStream: false,
  activityEvents: true,
  toolEvents: true,
  approvals: false,
  conversationResume: false,
  serverInitiatedCalls: false,
};

/**
 * Deterministic streamed agent for building and testing the voice loop without a real agent
 * (BUILD_ORDER Milestone 3). Replies are fixed by what the caller says, streamed a few words at a
 * time. Phrases that exercise specific paths:
 *
 * - "check" / "look up" / "search" / "find": a pretend tool call first (activity UI, no dead air);
 * - "story" / "explain" / "long": a long answer (for interrupting, Milestone 4);
 * - "format" / "markdown": markdown in the reply (speech must not read the syntax);
 * - "simulate a failure": an agent error part-way through;
 * - "simulate silence": no answer at all (Twring's timeout path).
 */
export class FakeAgentAdapter implements TwringAgentAdapter {
  readonly name = 'fake';
  readonly capabilities = CAPABILITIES;
  private readonly sleep: Sleep;
  private turns = 0;

  constructor(private readonly options: FakeAgentOptions = {}) {
    this.sleep = options.sleep ?? systemSleep;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  async *sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.turns += 1;
    const script = fakeReply(turn.text, this.turns);
    let n = 0;
    const next = () => {
      n += 1;
      return { event_id: `evt_${n}`, turn_id: turn.turnId, seq: n };
    };
    const messageId = `msg_${turn.turnId}`;

    await this.sleep(this.options.thinkMs ?? 300, signal);
    if (script.silent) {
      await untilAborted(signal);
      return;
    }
    yield { type: 'run.started', ...next() };

    if (script.tool !== undefined) {
      yield {
        type: 'tool.start',
        ...next(),
        tool_call_id: 'tool_1',
        tool_name: script.tool.name,
        display_label: script.tool.label,
      };
      await this.sleep(this.options.toolMs ?? 1500, signal);
      yield { type: 'tool.end', ...next(), tool_call_id: 'tool_1', status: 'success' };
    }

    yield { type: 'text.start', ...next(), message_id: messageId };
    for (const delta of toDeltas(script.text)) {
      yield { type: 'text.delta', ...next(), message_id: messageId, delta };
      await this.sleep(this.options.deltaMs ?? 40, signal);
    }
    yield { type: 'text.end', ...next(), message_id: messageId };
    if (script.fail) {
      yield { type: 'error', ...next(), code: 'fake_failure', retryable: true };
      return;
    }
    yield { type: 'done', ...next(), status: 'completed' };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason as Error);
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

/** Splits text into 1–3 word deltas, keeping spaces attached, the way model tokens arrive. */
export function toDeltas(text: string): string[] {
  const words = text.match(/\S+\s*/g) ?? [];
  const deltas: string[] = [];
  for (let i = 0; i < words.length;) {
    const size = 1 + (deltas.length % 3);
    deltas.push(words.slice(i, i + size).join(''));
    i += size;
  }
  return deltas;
}

/**
 * What the demo agent says to anything it has no script for: it is a demo, so it says so and
 * suggests something to try rather than repeating the caller's words back.
 */
export const DEMO_FALLBACKS = [
  "I'm Twring's demo agent, so I can't really answer that. But you can ask me to check your calendar, tell you a story, or show you formatted text.",
  "Good question, but I'm only a demo agent. Try asking me to look something up, or to tell you a story you can interrupt.",
  "I don't have a real brain behind me, I'm just Twring's demo. Connect your own agent for real answers, or ask me for a story.",
  "That's beyond this demo agent. Ask me to check the weather, explain something at length, or show you some formatting.",
];

export function fakeReply(heard: string, turnNumber: number): Script {
  const text = heard.trim();
  const lower = text.toLowerCase();
  if (lower.includes('simulate silence')) return { text: '', silent: true };
  if (lower.includes('simulate a failure')) {
    return { text: 'Let me start on that. ', fail: true };
  }
  if (/\b(check|look up|search|find)\b/.test(lower)) {
    return {
      tool: { name: 'fake.lookup', label: 'Looking that up…' },
      text: "I looked, but I'm only a demo agent, so there's no real calendar here. A connected agent would answer from its own tools.",
    };
  }
  if (/\b(story|explain|long)\b/.test(lower)) {
    return {
      text: 'Here is a longer answer, so you can hear how streaming feels. A lighthouse keeper once kept a notebook of every ship that passed. Most nights the entries were short: a name, a time, the weather. One winter a small boat came by with no name at all, just a lantern and a wave. He wrote it down anyway, and the next morning he found the same lantern hanging on his own door. He never learned who left it. That is the whole story.',
    };
  }
  if (/\b(format|markdown)\b/.test(lower)) {
    return {
      text: 'Here is **formatted** text:\n\n- first, a list item\n- then a [link](https://example.com)\n\nand `code` should not be read out as symbols.',
    };
  }
  if (/^(hi|hello|hey)\b/.test(lower)) {
    return {
      text: "Hi! I'm Twring's demo agent. Ask me to check your calendar, tell you a story, or show you formatted text.",
    };
  }
  return { text: DEMO_FALLBACKS[(turnNumber - 1) % DEMO_FALLBACKS.length]! };
}
