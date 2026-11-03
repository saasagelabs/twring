import { AgentStreamGuard, isAdapterError, type TwringAgentAdapter } from '@twring/agent-adapter';
import { INTERRUPTION_KEYTERMS } from '@twring/config/gateway';
import {
  AGENT_HANGUP_LINGER_MS,
  HANGUP_MARKERS,
  type AgentEvent,
  type FloorMessage,
  type StatusMessage,
  type UserTurn,
} from '@twring/contracts';

import type { CallLogger } from '../calls/runtime';
import type { Scheduler } from '../calls/scheduler';
import { toSafeError } from '../redact';

import {
  ECHO_FINISHED_TAIL_MS,
  ECHO_TAIL_MS,
  audibleSpan,
  echoPrefixLength,
  echoWindow,
  echoWords,
  judgeTail,
  newWords,
  type EchoWindow,
} from './echo';
import {
  ACK_LINE_AFTER_MS,
  CUE_FINISH_GRACE_MS,
  GENERIC_PROGRESS_LINE_AFTER_MS,
  MAX_PROGRESS_LINES,
  OPENING_TURN_QUIET_MS,
  PRESENCE_TONE_AFTER_MS,
  PROGRESS_LINE_AFTER_MS,
  PROGRESS_LINE_RECHECK_MS,
  PROGRESS_LINE_REPEAT_MS,
  STOPPED_LINE,
  ackLine,
  progressLine,
  spokenActivityLabel,
} from './presence';
import { SpeechTextFilter } from './speech-text';
import {
  APPROVAL_DENIED_LINE,
  APPROVAL_REASK,
  APPROVAL_TIMEOUT_LINE,
  APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_WORDS,
  UNKNOWN_AGENT_NAME,
  approvalPrompt,
  approvalTitle,
  approvalVoiceDecision,
  cleanApprovalText,
} from './approvals';

/** Named agent budgets (CALL_STATE_MACHINE §10). Exceeding one ends the turn, never the call. */
export const AGENT_TIMEOUTS = {
  /** Committed turn → first agent event. */
  firstEventMs: 20_000,
  /** Longest silence between agent events once it has started. */
  idleMs: 30_000,
  /** Whole turn, however busy the agent is. */
  totalMs: 180_000,
} as const;

/** Visible reply text is sent to the phone at most this often while it streams. */
const TEXT_UPDATE_MS = 150;
/** Longest reply text shown on the phone; status packets are size-capped. */
const MAX_VISIBLE_CHARS = 1500;
/** C0 controls other than tab and newline: meaningless on screen, 6 bytes each once JSON-escaped. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F]/g;
/** Half a surrogate pair on its own: renders as garbage and JSON-escapes to 6 bytes. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Shown while the agent works without saying what it is doing (UX_UI_SPEC §12). */
const GENERIC_ACTIVITY = 'Working…';

/**
 * Bound on a user turn's text after merging unanswered superseded turns into it ("keep talking");
 * past it, the most recent text is kept.
 */
export const MAX_MERGED_TURN_CHARS = 2000;

/** Bound on any user turn's text sent to an agent; past it, the most recent text is kept. */
export const MAX_USER_TURN_CHARS = 8000;

export const MERGED_TURN_NOTE =
  '[Your last reply was cut off because I kept talking. Here is my full request:]';

/**
 * Adapters whose `streamingText: false` means a real agent that doesn't stream, so the caller gets
 * the one-time `agent_not_streaming` notice. Built-in test lines (the repeat agent) answer in one
 * piece on purpose and stay quiet.
 */
const NOT_STREAMING_NOTICE_ADAPTERS: ReadonlySet<string> = new Set(['cord-native', 'cord-rest']);

/** The most recent `max` UTF-16 units of `text`, never starting on half a surrogate pair. */
function keepRecent(text: string, max: number): string {
  if (text.length <= max) return text;
  const kept = text.slice(-max);
  const first = kept.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? kept.slice(1) : kept;
}

/**
 * Words that only ask the agent to stop talking (ADR-017). A barge-in made of nothing else is not
 * sent to the agent: the cut already did what the caller asked. English only.
 */
export const FLOOR_CONTROL_WORDS: readonly string[] = [
  'wait',
  'stop',
  'hold on',
  'hang on',
  'one second',
  'one sec',
  'pause',
  'shh',
  'sorry',
  'excuse me',
];

/**
 * A 1–2 word barge-in that is not all floor-control words is held this long (ADR-017): echo
 * cancellation clips the first word spoken over the agent ("wait" → "Rate"), so the caller's next
 * words likely say what they meant.
 */
export const SHORT_BARGE_IN_GRACE_MS = 1500;

const FLOOR_CONTROL_PHRASES = FLOOR_CONTROL_WORDS.map((w) => echoWords(w));

/**
 * Words that ask a working agent to stop what it is doing (ADR-026): the STT interruption keyterms
 * plus explicit cancels. Unlike other talk, a stop request cancels a turn that has started a tool.
 */
export const STOP_REQUEST_WORDS: readonly string[] = [
  ...new Set([
    ...INTERRUPTION_KEYTERMS,
    'stop',
    'cancel',
    'wait',
    'hold on',
    'never mind',
    'nevermind',
    'stop it',
    'cancel that',
  ]),
];

/**
 * A stop request is short: at most this many words, at least one a stop word and the rest from
 * STOP_FILLER_WORDS or the agent's display name ("Hermes, stop", "no, cancel", ADR-028).
 */
export const MAX_STOP_REQUEST_WORDS = 6;

/** Words allowed around a stop word without making it a real request ("please stop"). */
export const STOP_FILLER_WORDS: readonly string[] = ['please', 'no', 'ok', 'okay', 'just', 'hey'];

// Longest first: "stop it" must not be read as "stop" followed by a stray "it".
const STOP_REQUEST_PHRASES = STOP_REQUEST_WORDS.map((w) => echoWords(w)).sort(
  (a, b) => b.length - a.length,
);

const STOP_FILLERS: ReadonlySet<string> = new Set(STOP_FILLER_WORDS.flatMap((w) => echoWords(w)));

/**
 * `text` only asks the agent to stop ("Stop.", "Cancel that!", "never mind, wait", "Hermes,
 * stop"): stop words plus fillers or the agent's name, never a request ("stop the build").
 */
export function isStopRequest(text: string, agentName?: string): boolean {
  const words = echoWords(text);
  if (words.length > MAX_STOP_REQUEST_WORDS) return false;
  const name = new Set(agentName === undefined ? [] : echoWords(agentName));
  const rest = words.filter((w) => !STOP_FILLERS.has(w) && !name.has(w));
  return consistsOf(rest, STOP_REQUEST_PHRASES, false);
}

/** `words` is one or more floor-control phrases and nothing else ("stop stop", "hold on wait"). */
export function isFloorControl(words: readonly string[]): boolean {
  return consistsOf(words, FLOOR_CONTROL_PHRASES, true);
}

/** `words` is one or more of `phrases` and nothing else (and "shh", when `shush`). */
function consistsOf(
  words: readonly string[],
  phrases: readonly (readonly string[])[],
  shush: boolean,
): boolean {
  if (words.length === 0) return false;
  let i = 0;
  outer: while (i < words.length) {
    if (shush && /^sh+$/.test(words[i] ?? '')) {
      i += 1;
      continue;
    }
    for (const phrase of phrases) {
      if (phrase.length > 0 && phrase.every((w, k) => words[i + k] === w)) {
        i += phrase.length;
        continue outer;
      }
    }
    return false;
  }
  return true;
}

/** The speech half of the voice pipeline, as the conversation drives it. */
export interface SpeechOutput {
  begin(committedAt: number): string;
  append(generationId: string, text: string): void;
  end(generationId: string): void;
  cancel(reason: 'barge_in' | 'superseded' | 'call_ended'): void;
  /** Scheduler time the caller's voice rose over the speech in progress, if it did (telemetry). */
  callerOnsetAt(): number | undefined;
  /**
   * Plays the short "heard you" tone (ADR-028) on the outgoing audio. Twring's own audio like TTS,
   * but no generation: nothing to echo-match, nothing a barge-in has to cut.
   */
  playTone?(): void;
  /** Audio of this generation played out so far, in ms (echo window position). */
  playedMs(generationId: string): number;
  /** The generation's whole audio length, once TTS has delivered all of it. */
  totalAudioMs(generationId: string): number | undefined;
}

/** A generation's speakable text and when it stopped being audible (echo window, ADR-015). */
interface SpokenGeneration {
  id: string;
  text: string;
  /** Its first frame played. */
  played: boolean;
  /** Played out in full (the playout position is the end of its text). */
  finished: boolean;
  /** Scheduler time its last frame played, or it was cut or failed. */
  endedAt?: number;
  /**
   * Twring's own line (ADR-028, ADR-032): its echo counts for ECHO_TAIL_MS even when it played out,
   * because a working turn is still open behind it and an echoed "one moment" must not supersede it.
   */
  cue?: true;
}

/** A generation's text and the stretch of it an utterance may have heard. */
interface EchoSpan {
  text: string;
  start: number;
  end: number;
}

/** The caller's utterance in progress, from speech start to commit or discard. */
interface Utterance {
  /** It started while the agent was audible: only then can it be echo. */
  audibleStart: boolean;
  /** A partial proved it is not echo: its commit is never dropped. */
  real: boolean;
  /** Words of the previous partial (partials are cumulative). */
  lastWords?: string[];
  /**
   * Per generation, the one continuous stretch of its text audible at any point while the
   * utterance was live (min start, max end), so a long echo commit matches as a single run.
   */
  spans: Map<string, EchoSpan>;
  echoLogged: boolean;
  /** It confirmed a barge-in that cut the agent's speech. */
  cut: boolean;
}

/** A short committed utterance waiting for the caller's next words (ADR-017). */
interface HeldShortTurn {
  text: string;
  words: number;
  reason: 'barge_in' | 'turn';
  startedAt: number;
  cancelTimer: () => void;
  /** The grace ran out while the caller was talking again: sent (or merged) once that settles. */
  expired: boolean;
}

export interface ConversationOptions {
  callId: string;
  adapter: TwringAgentAdapter;
  speech: SpeechOutput;
  scheduler: Scheduler;
  logger: CallLogger;
  /** Reliable status channel to the phone. */
  send: (message: StatusMessage) => void;
  /** Wall clock for turn timestamps; the scheduler's clock is monotonic. */
  wallClock?: () => number;
  timeouts?: Partial<Record<keyof typeof AGENT_TIMEOUTS, number>>;
  /**
   * A turn failed in a way no later turn can recover from (the agent rejected Twring's credentials).
   * Request-per-turn agents (REST) only reveal this on the first turn; the runtime ends the call.
   */
  onAgentUnusable?: (code: string) => void;
  /**
   * The agent asked to hang up (its hang-up marker, ADR-024), its reply played out, and the owner
   * stayed quiet for AGENT_HANGUP_LINGER_MS: the runtime ends the call as `agent_hangup`.
   */
  onAgentHangup?: () => void;
  /** The agent's display name: "Hermes, stop" is still only a stop request (ADR-028). */
  agentName?: string;
  /** The "heard you" tone and spoken progress lines while the agent works (ADR-028). Off unless set. */
  presenceCues?: boolean;
  /** A short spoken "one moment" while the agent is still silent (ADR-032). Needs `presenceCues`. */
  acknowledge?: boolean;
  /** Grace for a short normal turn; absent or 0 sends it immediately. */
  shortTurnHoldMs?: number;
}

/** Any hang-up marker in any letter case (`⟪HANGUP⟫` must not be spoken either). */
const HANGUP_PATTERN = new RegExp(
  HANGUP_MARKERS.map((marker) => marker.replace(/[[\]]/g, '\\$&')).join('|'),
  'gi',
);

/**
 * Removes hang-up markers from `text`. Unless `flush`, a trailing piece that could still become a
 * marker once more text arrives is returned as `carry` instead of being released.
 */
export function stripHangupMarkers(
  text: string,
  flush: boolean,
): { text: string; carry: string; found: boolean } {
  const out = text.replace(HANGUP_PATTERN, '');
  const found = out.length !== text.length;
  if (flush) return { text: out, carry: '', found };
  for (let length = Math.min(out.length, 10); length > 0; length -= 1) {
    const tail = out.slice(-length);
    const lower = tail.toLowerCase();
    if (HANGUP_MARKERS.some((marker) => marker.length > length && marker.startsWith(lower))) {
      return { text: out.slice(0, -length), carry: tail, found };
    }
  }
  return { text: out, carry: '', found };
}

type Budget = 'firstEvent' | 'idle' | 'total';

type Floor = Pick<FloorMessage, 'floor' | 'turn_id' | 'activity'>;

interface Turn {
  id: string;
  controller: AbortController;
  committedAt: number;
  filter: SpeechTextFilter;
  visible: string;
  lastTextSentAt: number;
  textTimer?: () => void;
  /** The generation speaking this turn, from `begin` until the pipeline reports it finished/failed. */
  generationId?: string;
  /** The generation was ended (agent done, or a tool/activity boundary) and is playing out. */
  generationEnded: boolean;
  speaking: boolean;
  /** The caller barged in: nothing more from this turn is spoken; its text is still shown. */
  muted: boolean;
  /**
   * Speakable text held back while the caller talks over a working agent (ADR-015), or while the
   * previous generation, already ended, is still playing out.
   */
  heldSpeech: string;
  /** Held text crossed a tool/activity boundary: once released, its generation is ended at once. */
  heldBoundary: boolean;
  speechDone: boolean;
  agentDone: boolean;
  activity?: string;
  firstEventLogged: boolean;
  firstTextLogged: boolean;
  timers: Map<string, () => void>;
  /** Owner text, including any merged unanswered turns, without the agent-only note. */
  userText: string;
  /** How many committed user turns that text spans. */
  mergedTurns: number;
  /** Some of this turn's speech was audible: the caller heard an answer to it. */
  heard: boolean;
  /**
   * The caller cut this turn off with floor-control words or a held short barge-in (ADR-017): it
   * runs on silently and the floor shows listening, not agent_working.
   */
  yielded: boolean;
  /** The agent reported a tool call or activity: it may have acted, so the turn is never re-sent. */
  mayHaveActed: boolean;
  /** The agent started a tool: more talk is queued behind this turn, not sent over it (ADR-026). */
  toolStarted: boolean;
  /** Agent text that may be the start of a hang-up marker, held until the next delta. */
  markerCarry: string;
  /** The agent's text carried a hang-up marker (ADR-024). */
  hangupRequested: boolean;
  /** An answered ring's opening turn (ADR-024): no tone, and a quiet start (ADR-028). */
  opening: boolean;
  /** Where `activity` came from, for the progress line's log. */
  activityKind?: 'tool' | 'activity';
  /** Scheduler time of the commit, the agent's last text, or its last speech ending (ADR-028). */
  lastTextAt: number;
  /** Progress lines spoken for this turn, and when the last one started (ADR-028). */
  progressLines: number;
  lastLineAt?: number;
  /** A due line was skipped; wait for the next repeat interval before checking again. */
  lastProgressCheckAt?: number;
  lastSpokenProgressLabel?: string;
  genericProgressSaid: boolean;
  /** The owner heard an acknowledgement for this request, here or in a turn it took in (ADR-032). */
  acked: boolean;
  totalBudgetRemaining: number;
  totalBudgetStartedAt: number;
  approval?: PendingApproval;
}

/** The one approval a turn may be waiting on (ADR-029). */
interface PendingApproval {
  id: string;
  cancelTimeout: () => void;
  reasked: boolean;
  /** Wall time it was asked: an answer the owner started before then was not to this question. */
  askedAt: number;
  /** What the phone was shown, sent again when the phone rejoins. */
  message: StatusMessage;
}

/** A line Twring speaks itself in the agent's voice (ADR-028): never sent to the agent. */
interface Cue {
  generationId: string;
  kind: 'progress' | 'stopped' | 'approval' | 'ack';
  /** The working turn a progress line is about. */
  turnId?: string;
}

/** Who a committed turn comes from: the owner just now, the queue, or an answered ring. */
type TurnSource = 'owner' | 'queued' | 'opening';

/**
 * The conversation half of a call (VOICE_ARCHITECTURE §6–13): turns committed user speech into one
 * agent turn each, streams the agent's text into speech and onto the phone, and owns the floor the
 * phone mirrors (ADR-014). The agent keeps its own tools: Twring only relays what it says and does.
 */
export class ConversationController {
  private readonly timeouts: Record<keyof typeof AGENT_TIMEOUTS, number>;
  private readonly wallClock: () => number;
  private turn: Turn | undefined;
  private turnCount = 0;
  private userSpeaking = false;
  private speechStartedAt: number | undefined;
  /**
   * The caller started talking over speech in progress; the barge-in waits for the first partial
   * that is not echo of the agent's own voice (ADR-015).
   */
  private pendingBargeIn: { startedAt: number; onsetAt: number | undefined } | undefined;
  private utterance: Utterance | undefined;
  private heldShort: HeldShortTurn | undefined;
  /** Generations still playing, or still in their echo tail (echo window). */
  private generations: SpokenGeneration[] = [];
  private floor: Floor = { floor: 'listening' };
  private floorSeq = 0;
  private closed = false;
  private readonly decidedApprovals = new Set<string>();
  private notStreamingNoticeSent = false;
  /**
   * Some turn got at least one event from the agent. Until then, failures that suggest the agent
   * can't be used at all (403, never reached) end the call instead of failing a turn.
   */
  private agentAnswered = false;
  private readonly counts = { completed: 0, failed: 0, bargeIns: 0 };
  /** Cancels the lingering window after the agent's hang-up (ADR-024). */
  private cancelHangup: (() => void) | undefined;
  /** The hang-up reply ended while the owner was talking: the window waits for their speech. */
  private hangupDeferred = false;
  /** A progress line, "Okay, stopped." (ADR-028) or an acknowledgement (ADR-032) playing. */
  private cue: Cue | undefined;
  /** Acknowledgements spoken this call, to take turns between the lines (ADR-032). */
  private acks = 0;
  /**
   * What the owner said while the agent was working with tools (ADR-026): sent as the next turn
   * once the current one finishes, instead of cancelling its work.
   */
  private queued:
    | {
        text: string;
        startedAt: number;
        turns: number;
        /** The turn it waited behind asked to hang up; the queued turn wins (logged when sent). */
        hangupSkipped?: boolean;
      }
    | undefined;

  constructor(private readonly options: ConversationOptions) {
    this.timeouts = { ...AGENT_TIMEOUTS, ...options.timeouts };
    this.wallClock = options.wallClock ?? Date.now;
  }

  async connect(signal: AbortSignal): Promise<void> {
    const { callId } = this.options;
    await this.options.adapter.connect({ callId, sessionId: callId }, signal);
  }

  /**
   * STT heard the caller start talking (ADR-015). Over speech in progress (open, or still playing
   * out) this is only a pending barge-in: it may be the agent's own voice leaking past the phone's
   * echo canceller, so the first partial that is not echo confirms it, and then that speech stops
   * for good. Over a working agent the caller takes the floor at once and the answer is held until
   * the caller either commits a turn (which supersedes it) or turns out to have made only noise.
   * A silent tool call after a spoken preamble has no speech in progress: only held.
   */
  userSpeechStarted(): void {
    if (this.closed) return;
    if (this.cancelHangup !== undefined) {
      // The owner started speaking in the lingering window: the call goes on.
      this.clearHangup();
      this.log('agent_hangup_cancelled');
    }
    this.speechStartedAt ??= this.wallClock();
    this.userSpeaking = true;
    if (this.utterance === undefined) {
      const utterance: Utterance = {
        audibleStart: this.agentAudible(),
        real: false,
        spans: new Map(),
        echoLogged: false,
        cut: false,
      };
      if (utterance.audibleStart) this.extendSpans(utterance);
      this.utterance = utterance;
    }
    const turn = this.turn;
    if (
      this.pendingBargeIn === undefined &&
      (turn?.generationId !== undefined || this.cue !== undefined)
    ) {
      this.pendingBargeIn = {
        startedAt: this.options.scheduler.now(),
        onsetAt: this.options.speech.callerOnsetAt(),
      };
    }
    this.updateFloor();
  }

  /**
   * Live (uncommitted) words of the caller's speech. Only the words new since the previous partial
   * are judged; the first that are not echo of what the agent is audibly saying make the utterance
   * real and confirm a pending barge-in.
   */
  userPartial(text: string): void {
    const utterance = this.utterance;
    if (this.closed || utterance === undefined) return;
    const words = echoWords(text);
    const tail = newWords(utterance.lastWords, words);
    utterance.lastWords = words;
    if (utterance.real || tail.length === 0) return;
    if (utterance.audibleStart) {
      const verdict = judgeTail(tail, this.extendSpans(utterance));
      if (verdict.echo) {
        if (!utterance.echoLogged) {
          utterance.echoLogged = true;
          this.log('echo_rejected', {
            phase: 'partial',
            words: verdict.words,
            overlap: round2(verdict.overlap),
          });
        }
        return;
      }
    }
    utterance.real = true;
    this.confirmBargeIn();
  }

  /** The started speech turned out to be nothing (noise), or STT lost it. */
  userSpeechDiscarded(): void {
    // A hang-up waiting on the owner's speech (ADR-024): it was noise, so the window starts now.
    const resumeHangup = this.hangupDeferred;
    this.hangupDeferred = false;
    try {
      this.discardSpeech();
    } finally {
      // Talk queued behind a turn that ended while the owner spoke goes now (ADR-026).
      this.sendQueued();
      if (resumeHangup && !this.closed && this.turn === undefined) this.scheduleHangup();
    }
  }

  private discardSpeech(): void {
    this.speechStartedAt = undefined;
    this.utterance = undefined;
    this.pendingBargeIn = undefined;
    if (this.heldShort?.expired === true) {
      this.userSpeaking = false;
      this.releaseShortTurn();
      return;
    }
    if (!this.userSpeaking) return;
    this.userSpeaking = false;
    if (this.turn !== undefined) this.releaseHeldSpeech(this.turn);
    this.updateFloor();
  }

  /** The caller holds the floor: talking, and not a barge-in still waiting to prove it is not echo. */
  private get callerHasFloor(): boolean {
    return this.userSpeaking && this.pendingBargeIn === undefined;
  }

  /** Returns whether the agent's speech was cut. */
  private confirmBargeIn(): boolean {
    const pending = this.pendingBargeIn;
    if (pending === undefined) return false;
    this.pendingBargeIn = undefined;
    // Twring's own line stops like agent speech, but cuts nothing of the turn: it keeps working and
    // its answer still plays (ADR-028).
    this.cutCue('barge_in');
    const turn = this.turn;
    let cut = false;
    if (turn !== undefined && turn.generationId !== undefined && !turn.muted) {
      this.bargeIn(turn, pending);
      cut = true;
      if (this.utterance !== undefined) this.utterance.cut = true;
    }
    this.updateFloor();
    return cut;
  }

  /**
   * Generations still audible: playing, or ended under ECHO_FINISHED_TAIL_MS (played out) or
   * ECHO_TAIL_MS (cut, or Twring's own line) ago. Prunes the rest.
   */
  private audibleGenerations(): SpokenGeneration[] {
    const now = this.options.scheduler.now();
    this.generations = this.generations.filter(
      (g) =>
        g.endedAt === undefined ||
        now - g.endedAt < (g.finished && g.cue !== true ? ECHO_FINISHED_TAIL_MS : ECHO_TAIL_MS),
    );
    return this.generations.filter((g) => g.played || g.finished);
  }

  private agentAudible(): boolean {
    return this.audibleGenerations().some((g) => g.text.trim() !== '');
  }

  /**
   * Widens the utterance's span of each audible generation to what is audible now (a window around
   * its playout), and returns the utterance's echo window: one run per generation span.
   */
  private extendSpans(utterance: Utterance): EchoWindow {
    const { speech } = this.options;
    for (const g of this.audibleGenerations()) {
      const now = audibleSpan(
        g.text,
        g.finished ? Number.POSITIVE_INFINITY : speech.playedMs(g.id),
        speech.totalAudioMs(g.id),
      );
      const span = utterance.spans.get(g.id);
      if (span === undefined) utterance.spans.set(g.id, { text: g.text, ...now });
      else {
        span.text = g.text;
        span.start = Math.min(span.start, now.start);
        span.end = Math.max(span.end, now.end);
      }
    }
    return echoWindow([...utterance.spans.values()].map((s) => s.text.slice(s.start, s.end)));
  }

  /** The generation stopped being audible now: it keeps its tail window for a while. */
  private generationEnded(id: string | undefined, finished: boolean): void {
    const generation = this.generations.find((g) => g.id === id);
    if (generation === undefined || generation.endedAt !== undefined) return;
    generation.endedAt = this.options.scheduler.now();
    generation.finished = finished;
  }

  /** A committed user turn: sent to the agent exactly once, superseding any turn in progress. */
  userTurn(text: string): void {
    if (this.closed) return;
    const utterance = this.utterance;
    this.utterance = undefined;
    if (utterance?.audibleStart === true && !utterance.real) {
      // Only an utterance that started over the agent's voice and never proved itself can be echo:
      // it is, if nothing is left once the leading run of the agent's audible words is stripped.
      const window = this.extendSpans(utterance);
      const words = echoWords(text);
      const matched = echoPrefixLength(words, window);
      if (matched === words.length) {
        // The agent's own voice, committed by STT: dropped as if it were noise.
        this.log('echo_rejected', {
          phase: 'commit',
          words: words.length,
          overlap: words.length === 0 ? 1 : round2(matched / words.length),
        });
        const approval = this.turn?.approval;
        if (
          approval !== undefined &&
          approvalVoiceDecision(text, this.options.agentName) !== undefined &&
          this.reaskApproval(approval)
        ) {
          this.log('approval_reask_after_echo', { turn_id: this.turn?.id });
        }
        this.userSpeechDiscarded();
        return;
      }
    }
    if (this.turn?.approval !== undefined) {
      const spokenFrom = this.speechStartedAt;
      this.pendingBargeIn = undefined;
      this.speechStartedAt = undefined;
      this.userSpeaking = false;
      this.handleApprovalSpeech(text, spokenFrom);
      this.updateFloor();
      return;
    }
    const confirmed = this.pendingBargeIn !== undefined && this.confirmBargeIn();
    const cut = utterance?.audibleStart === true && (utterance.cut || confirmed);
    const startedAt = this.speechStartedAt ?? this.wallClock();
    this.speechStartedAt = undefined;
    this.userSpeaking = false;
    const held = this.heldShort;
    if (held === undefined && cut) {
      // ADR-017: a barge-in is often only "stop", or a clipped first word; the cut is done already.
      const words = echoWords(text);
      if (isFloorControl(words)) {
        this.log('floor_control', { words: words.length });
        this.yieldTurn();
        this.afterFloorControl(text);
        return;
      }
      if (words.length <= 2) {
        this.holdShortTurn(text, words.length, startedAt, SHORT_BARGE_IN_GRACE_MS, 'barge_in');
        return;
      }
    }
    const shortTurnHoldMs = this.options.shortTurnHoldMs ?? 0;
    if (held === undefined && !cut && shortTurnHoldMs > 0) {
      const words = echoWords(text);
      if (
        words.length >= 1 &&
        words.length <= 2 &&
        !isStopRequest(text, this.options.agentName) &&
        !isFloorControl(words)
      ) {
        this.holdShortTurn(text, words.length, startedAt, shortTurnHoldMs, 'turn');
        return;
      }
    }
    if (held !== undefined && isFloorControl(echoWords(text))) {
      // ADR-017: a held clipped word followed only by floor-control words ("Rate," then "Wait.")
      // was a request for the floor, not a request for the agent: both are dropped.
      this.clearHeldShort();
      this.log('floor_control', { words: echoWords(text).length });
      this.yieldTurn();
      this.afterFloorControl(text);
      return;
    }
    let userText = text;
    let turnStartedAt = startedAt;
    if (held !== undefined) {
      this.clearHeldShort();
      userText = `${held.text} ${text}`;
      if (userText.length > MAX_MERGED_TURN_CHARS)
        userText = userText.slice(-MAX_MERGED_TURN_CHARS);
      turnStartedAt = held.startedAt;
      this.log('short_turn_released', { words: held.words, merged: true, reason: held.reason });
    }
    this.commitTurn(userText, turnStartedAt);
  }

  /**
   * The caller's barge-in only took the floor (ADR-017): the floor shows listening. A running agent
   * turn is not cancelled (the caller asked it to stop talking, not to stop working) and runs on
   * muted until it finishes or the caller's next real turn supersedes it.
   */
  private yieldTurn(): void {
    if (this.turn !== undefined) this.turn.yielded = true;
    this.updateFloor();
  }

  /**
   * Floor-control words are never sent, but talk queued behind a turn that ended while the owner
   * spoke still waits (ADR-026): a stop request drops it, anything else lets it go now.
   */
  private afterFloorControl(text: string): void {
    if (this.queued === undefined || this.turn !== undefined) return;
    if (isStopRequest(text, this.options.agentName)) this.dropQueued('stop_request');
    else this.sendQueued();
  }

  private holdShortTurn(
    text: string,
    words: number,
    startedAt: number,
    graceMs: number,
    reason: 'barge_in' | 'turn',
  ): void {
    this.log('short_turn_held', { words, reason });
    const held: HeldShortTurn = {
      text,
      words,
      reason,
      startedAt,
      expired: false,
      cancelTimer: this.options.scheduler.setTimeout(() => {
        if (this.heldShort !== held) return;
        held.expired = true;
        // The caller is talking again: their commit merges it, a discard releases it.
        if (this.utterance === undefined && !this.userSpeaking) this.releaseShortTurn();
      }, graceMs),
    };
    this.heldShort = held;
    if (reason === 'barge_in') this.yieldTurn();
    else this.updateFloor();
  }

  /** The grace ran out with no more words: the held text goes to the agent alone. */
  private releaseShortTurn(): void {
    const held = this.heldShort;
    if (held === undefined || this.closed) return;
    this.clearHeldShort();
    this.log('short_turn_released', { words: held.words, merged: false, reason: held.reason });
    this.commitTurn(held.text, held.startedAt);
  }

  private clearHeldShort(): void {
    this.heldShort?.cancelTimer();
    this.heldShort = undefined;
  }

  /**
   * Why an unheard superseded turn must not be merged into the next one, if it must not: merging
   * re-sends its text, so it is only safe when the agent provably did nothing it could act on
   * (never replay a non-idempotent action). Without tool events Twring cannot know, so no merge.
   */
  private mergeSkip(turn: Turn): 'agent_done' | 'agent_acted' | 'no_tool_events' | undefined {
    if (turn.agentDone) return 'agent_done';
    if (turn.mayHaveActed) return 'agent_acted';
    if (!this.options.adapter.capabilities.toolEvents) return 'no_tool_events';
    return undefined;
  }

  /**
   * Sends `text` to the agent as a new turn, superseding any turn in progress, unless that turn is
   * working with tools (ADR-026): then `text` waits behind it, and only a stop request cancels it.
   */
  private commitTurn(
    text: string,
    startedAt: number,
    source: TurnSource = 'owner',
    openingLine?: string,
  ): void {
    this.clearHangup();
    if (source === 'owner' && isStopRequest(text, this.options.agentName)) {
      this.stopRequested();
      return;
    }
    const current = this.turn;
    if (current !== undefined && !current.agentDone && current.toolStarted) {
      this.queueTurn(current, text, startedAt);
      return;
    }
    const queued = this.queued;
    if (queued === undefined) {
      this.sendTurn(text, startedAt, 1, source, openingLine);
      return;
    }
    // The working turn is done (its answer may still be playing, or it ended while the owner was
    // talking): the queued words go first.
    this.queued = undefined;
    const merged = keepRecent(`${queued.text} ${text}`, MAX_MERGED_TURN_CHARS);
    this.log('queued_turn_sent', {
      queued_turns: queued.turns,
      text_chars: merged.length,
      ...(queued.hangupSkipped === true && { hangup_skipped: true }),
    });
    this.sendTurn(merged, queued.startedAt, queued.turns + 1, 'owner');
  }

  /**
   * A stop request (ADR-026, ADR-028): cancels the turn in progress, tools or not, and drops the
   * queue. It is never sent to the agent as a turn of its own: "stop" is not work, and an agent
   * handed it starts a new run (it may even re-plan what it was told to stop). Twring itself says
   * "Okay, stopped." when it cancelled work.
   */
  private stopRequested(): void {
    this.dropQueued('stop_request');
    const current = this.turn;
    if (current === undefined) {
      this.log('stop_request_dropped');
      this.updateFloor();
      return;
    }
    const working = !current.agentDone;
    this.log('agent_stop_requested', {
      turn_id: current.id,
      working,
      tool_started: current.toolStarted,
    });
    this.supersede();
    this.updateFloor();
    if (working) this.speakCue(STOPPED_LINE, 'stopped');
  }

  /**
   * Sends the queue as the next turn once nothing runs. While the owner is talking it waits: their
   * commit takes it along (commitTurn), and speech that turns out to be noise sends it then. Sent
   * now, the owner's commit would cancel it a moment later (ADR-026).
   */
  private sendQueued(): void {
    const queued = this.queued;
    if (queued === undefined || this.closed || this.turn !== undefined) return;
    if (this.userSpeaking) {
      this.log('queued_turn_waiting', { queued_turns: queued.turns });
      return;
    }
    this.queued = undefined;
    this.log('queued_turn_sent', {
      queued_turns: queued.turns,
      text_chars: queued.text.length,
      ...(queued.hangupSkipped === true && { hangup_skipped: true }),
    });
    this.sendTurn(queued.text, queued.startedAt, queued.turns, 'queued');
  }

  /** The owner spoke while the agent works with tools: their words wait for the next turn. */
  private queueTurn(current: Turn, text: string, startedAt: number): void {
    const previous = this.queued;
    const queued = {
      text: keepRecent(
        previous === undefined ? text : `${previous.text} ${text}`,
        MAX_MERGED_TURN_CHARS,
      ),
      startedAt: previous?.startedAt ?? startedAt,
      turns: (previous?.turns ?? 0) + 1,
    };
    this.queued = queued;
    this.log('turn_queued', {
      turn_id: current.id,
      queued_turns: queued.turns,
      text_chars: queued.text.length,
    });
    this.updateFloor();
  }

  private dropQueued(reason: 'stop_request' | 'call_ended'): void {
    const queued = this.queued;
    if (queued === undefined) return;
    this.queued = undefined;
    this.log('queued_turn_dropped', { reason, queued_turns: queued.turns });
  }

  /** Sends `text` (spanning `turns` committed user turns) as a new turn, superseding any turn. */
  private sendTurn(
    text: string,
    startedAt: number,
    turns: number,
    source: TurnSource,
    openingLine?: string,
  ): void {
    const superseded = this.supersede();
    // "Keep talking": the caller paused mid-request and went on before hearing any answer. The
    // agent never answered the earlier part, so it goes along with this one rather than being lost.
    let userText = text;
    let mergedTurns = turns;
    let merged = false;
    const skip =
      superseded === undefined || superseded.heard ? undefined : this.mergeSkip(superseded);
    if (skip !== undefined) this.log('turn_merge_skipped', { reason: skip });
    if (superseded !== undefined && !superseded.heard && skip === undefined) {
      merged = true;
      userText = `${superseded.userText} ${text}`;
      if (userText.length > MAX_MERGED_TURN_CHARS)
        userText = userText.slice(-MAX_MERGED_TURN_CHARS);
      mergedTurns = superseded.mergedTurns + turns;
      this.log('turn_merged', { merged_turns: mergedTurns, text_chars: userText.length });
    }
    if (userText.length > MAX_USER_TURN_CHARS) {
      const originalChars = userText.length;
      userText = keepRecent(userText, MAX_USER_TURN_CHARS);
      this.log('turn_text_capped', { text_chars: originalChars, sent_chars: userText.length });
    }
    const committedAtWall = this.wallClock();
    this.turnCount += 1;
    const turn: Turn = {
      id: `turn_${this.turnCount}`,
      controller: new AbortController(),
      committedAt: this.options.scheduler.now(),
      filter: new SpeechTextFilter(),
      visible: '',
      lastTextSentAt: Number.NEGATIVE_INFINITY,
      generationEnded: false,
      speaking: false,
      muted: false,
      heldSpeech: '',
      heldBoundary: false,
      speechDone: false,
      agentDone: false,
      firstEventLogged: false,
      firstTextLogged: false,
      timers: new Map(),
      userText,
      mergedTurns,
      heard: false,
      yielded: false,
      mayHaveActed: false,
      toolStarted: false,
      markerCarry: '',
      hangupRequested: false,
      opening: source === 'opening',
      lastTextAt: this.options.scheduler.now(),
      progressLines: 0,
      genericProgressSaid: false,
      // One acknowledgement per request: a follow-up to a turn that was acknowledged and not yet
      // answered (merged or not) gets none.
      acked: superseded !== undefined && !superseded.heard && superseded.acked,
      totalBudgetRemaining: this.timeouts.totalMs,
      totalBudgetStartedAt: this.options.scheduler.now(),
    };
    this.turn = turn;
    this.updateFloor();
    this.startPresence(turn, source);
    if (openingLine !== undefined) {
      const line = openingLine.trim();
      if (line !== '') {
        this.log('opening_line', { text_chars: line.length });
        this.onText(turn, `${line} `);
      }
    }
    void this.run(turn, {
      callId: this.options.callId,
      sessionId: this.options.callId,
      turnId: turn.id,
      role: 'user',
      text: merged ? `${MERGED_TURN_NOTE} ${userText}` : userText,
      startedAt: new Date(startedAt).toISOString(),
      committedAt: new Date(committedAtWall).toISOString(),
    });
  }

  /** Audio from the pipeline for a generation this controller started. */
  speechState(generationId: string, state: 'playing' | 'finished' | 'failed'): void {
    if (state === 'playing') {
      const generation = this.generations.find((g) => g.id === generationId);
      if (generation !== undefined) generation.played = true;
    } else {
      this.generationEnded(generationId, state === 'finished');
    }
    if (this.cue?.generationId === generationId) {
      if (state !== 'playing') {
        const ended = this.cue;
        this.cue = undefined;
        // "One moment" counts as speech the owner heard: a line about a real activity comes 4 s
        // after it ends, not right after it (owner, 2026-10-24).
        const turnOfLine = this.turn;
        if (
          ended.kind === 'ack' &&
          state === 'finished' &&
          turnOfLine !== undefined &&
          ended.turnId === turnOfLine.id &&
          !turnOfLine.agentDone
        ) {
          turnOfLine.lastTextAt = this.options.scheduler.now();
          this.scheduleProgress(turnOfLine);
        }
        // Words that waited for this line to end play now.
        const waiting = this.turn;
        if (waiting?.timers.has('cue')) {
          waiting.timers.get('cue')?.();
          waiting.timers.delete('cue');
          this.releaseHeldSpeech(waiting);
        }
      }
      return;
    }
    const turn = this.turn;
    if (turn === undefined || turn.generationId !== generationId) return;
    switch (state) {
      case 'playing':
        turn.speaking = true;
        turn.heard = true;
        this.updateFloor();
        return;
      case 'finished':
        this.clearGeneration(turn);
        if (!turn.agentDone) {
          // Silence is counted from the end of what the owner heard, not from its text.
          turn.lastTextAt = this.options.scheduler.now();
          this.scheduleProgress(turn);
        }
        // With the agent done, the turn is over unless text held behind this generation is still
        // owed. Otherwise a preamble finished playing while the agent works on (a tool call): text
        // held behind it starts the next generation, and the floor shows what the agent is doing.
        if (turn.agentDone) this.settleSpeech(turn);
        else this.releaseHeldSpeech(turn);
        this.updateFloor();
        return;
      case 'failed':
        this.log('speech_failed', { turn_id: turn.id });
        this.clearGeneration(turn);
        // With the agent still answering, nothing is audible now, and its later text (with anything
        // held) starts a fresh generation once TTS is back.
        if (turn.agentDone) this.settleSpeech(turn);
        this.updateFloor();
        return;
    }
  }

  /** Turn and barge-in counts for the call's usage summary. */
  usage(): { turns: number; completed: number; failed: number; bargeIns: number } {
    return {
      turns: this.turnCount,
      completed: this.counts.completed,
      failed: this.counts.failed,
      bargeIns: this.counts.bargeIns,
    };
  }

  /** Test/diagnostic view of per-call state that must stay bounded however long the call runs. */
  retainedState(): { generations: number; turnTimers: number; spans: number } {
    return {
      generations: this.generations.length,
      turnTimers: this.turn === undefined ? 0 : this.turn.timers.size,
      spans: this.utterance?.spans.size ?? 0,
    };
  }

  /** Re-sends the current floor, e.g. after the caller rejoined. */
  resendFloor(): void {
    this.sendFloor();
    // A pending approval card was lost with the phone's connection: show it again (ADR-029).
    const approval = this.turn?.approval;
    if (approval !== undefined && !this.closed) this.options.send(approval.message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHeldShort();
    this.clearHangup();
    this.dropQueued('call_ended');
    const turn = this.turn;
    if (turn?.approval !== undefined) this.resolveApproval(turn.approval.id, 'deny', 'call_end');
    this.turn = undefined;
    if (turn !== undefined) this.stopTurn(turn, 'call_ended');
    this.cue = undefined;
    void this.options.adapter.close().catch(() => undefined);
  }

  private async run(turn: Turn, userTurn: UserTurn): Promise<void> {
    const { adapter } = this.options;
    const guard = new AgentStreamGuard(turn.id);
    this.log('agent_request_started', { turn_id: turn.id, text_chars: turn.userText.length });
    this.timer(turn, 'total', this.timeouts.totalMs);
    this.timer(turn, 'firstEvent', this.timeouts.firstEventMs);
    try {
      for await (const event of adapter.sendTurn(userTurn, turn.controller.signal)) {
        // Superseded, or already finished by Twring (timeout): anything the agent sends now is ignored.
        if (this.turn !== turn || turn.agentDone) return;
        const result = guard.accept(event);
        if (result.kind === 'ignored') continue;
        if (result.kind === 'violation') {
          this.log('agent_protocol_violation', { turn_id: turn.id, reason: result.reason });
          this.finishAgent(turn, 'failed');
          return;
        }
        this.cancelTimer(turn, 'firstEvent');
        this.timer(turn, 'idle', this.timeouts.idleMs);
        this.onAgentEvent(turn, result.event);
        if (turn.agentDone) return;
      }
      // The stream ended without `done` or `error`: the agent never said it finished.
      if (this.turn === turn && !turn.agentDone) {
        this.log('agent_stream_incomplete', { turn_id: turn.id });
        this.finishAgent(turn, 'failed');
      }
    } catch (error) {
      // Superseded, call ended, or already finished (a timeout ends the turn itself).
      if (this.turn !== turn || turn.agentDone) return;
      this.options.logger.warn(
        {
          event: 'agent_stream_failed',
          call_id: this.options.callId,
          turn_id: turn.id,
          err: toSafeError(error),
        },
        'agent stream failed',
      );
      if (isAdapterError(error)) {
        // 401 always means the credentials are wrong. A 403 or an agent never reached ends the call
        // only while no turn has been answered yet (likely a bad setup); later it fails the turn.
        const unusable =
          (error.code === 'auth_failed' && (error.httpStatus !== 403 || !this.agentAnswered)) ||
          (error.code === 'connection_failed' && !this.agentAnswered);
        if (unusable) {
          this.options.onAgentUnusable?.(error.code);
          return;
        }
        if (error.code === 'connection_failed') {
          this.finishAgent(turn, 'failed', 'agent_unreachable');
          return;
        }
      }
      this.finishAgent(turn, 'failed');
    }
  }

  private onAgentEvent(turn: Turn, event: AgentEvent): void {
    if (!turn.firstEventLogged) {
      turn.firstEventLogged = true;
      this.agentAnswered = true;
      this.log('agent_first_event', { turn_id: turn.id, duration_ms: this.since(turn) });
      this.noticeIfNotStreaming();
    }
    switch (event.type) {
      case 'run.started':
      case 'text.start':
      case 'text.end':
        return;
      case 'text.delta':
        this.onText(turn, event.delta);
        return;
      case 'activity':
        turn.mayHaveActed = true;
        this.closeGeneration(turn);
        turn.activityKind = 'activity';
        this.setActivity(turn, event.label);
        return;
      case 'tool.start':
        turn.mayHaveActed = true;
        turn.toolStarted = true;
        this.log('agent_tool_started', { turn_id: turn.id, tool: event.tool_name });
        this.closeGeneration(turn);
        turn.activityKind = 'tool';
        this.setActivity(turn, event.display_label ?? GENERIC_ACTIVITY);
        return;
      case 'tool.end':
        turn.mayHaveActed = true;
        this.log('agent_tool_ended', { turn_id: turn.id, status: event.status });
        this.setActivity(turn, undefined);
        return;
      case 'approval.required':
        this.requireApproval(turn, event);
        return;
      case 'approval.resolved':
        // The agent settled its own request (it timed out, was cancelled, or was answered on the
        // computer): the card goes away, and nothing is sent back as if the owner had decided.
        if (turn.approval?.id === event.approval_id)
          this.resolveApproval(event.approval_id, event.decision, 'call_end', false);
        return;
      case 'error':
        this.log('agent_error', { turn_id: turn.id, code: event.code });
        this.finishAgent(turn, 'failed');
        return;
      case 'done':
        this.finishAgent(turn, event.status === 'failed' ? 'failed' : 'completed');
        return;
      case 'file':
        // Files belong in the chat, not a call.
        return;
    }
  }

  private requireApproval(
    turn: Turn,
    event: Extract<AgentEvent, { type: 'approval.required' }>,
  ): void {
    if (turn.approval !== undefined || this.decidedApprovals.has(event.approval_id)) {
      // One approval at a time (ADR-029): a second request, or an id already answered, is denied
      // at once so the agent is not left waiting on a question nobody was asked.
      if (turn.approval?.id === event.approval_id) return;
      this.log('approval_extra_denied', { turn_id: turn.id, action: event.action });
      void this.options.adapter
        .decideApproval?.(turn.id, event.approval_id, 'deny')
        .catch(() => undefined);
      return;
    }
    turn.mayHaveActed = true;
    turn.toolStarted = true;
    this.closeGeneration(turn);
    // The prompt must be heard, so it cuts the agent's speech still playing. The pipeline would cut
    // it anyway when the prompt begins, without reporting it finished: cut it here so the turn does
    // not wait forever for that generation and later replies are still spoken.
    if (turn.generationId !== undefined) {
      this.generationEnded(turn.generationId, false);
      this.clearGeneration(turn);
      this.options.speech.cancel('superseded');
    }
    turn.timers.get('progress')?.();
    turn.timers.delete('progress');
    // Words waiting for Twring's line to end give way to the question, as playing speech does.
    if (turn.timers.has('cue')) {
      turn.timers.get('cue')?.();
      turn.timers.delete('cue');
      turn.heldSpeech = '';
      turn.heldBoundary = false;
    }
    this.cancelTimer(turn, 'idle');
    this.cancelTimer(turn, 'total');
    turn.totalBudgetRemaining = Math.max(
      1,
      turn.totalBudgetRemaining - (this.options.scheduler.now() - turn.totalBudgetStartedAt),
    );
    this.cutCue('superseded');
    const cancelTimeout = this.options.scheduler.setTimeout(() => {
      if (this.resolveApproval(event.approval_id, 'deny', 'timeout'))
        this.speakCue(APPROVAL_TIMEOUT_LINE, 'approval');
    }, APPROVAL_TIMEOUT_MS);
    const agentName = this.options.agentName || UNKNOWN_AGENT_NAME;
    const askedAt = this.wallClock();
    const description = event.description === undefined ? '' : cleanApprovalText(event.description);
    const message: StatusMessage = {
      v: 1,
      type: 'approval',
      call_id: this.options.callId,
      approval_id: event.approval_id,
      agent_name: agentName,
      action: event.action,
      title: approvalTitle(event.title, event.action),
      ...(description !== '' && { description }),
      expires_at: new Date(askedAt + APPROVAL_TIMEOUT_MS).toISOString(),
    };
    turn.approval = { id: event.approval_id, cancelTimeout, reasked: false, askedAt, message };
    this.log('approval_required', { turn_id: turn.id, action: event.action });
    this.options.send(message);
    this.updateFloor();
    this.speakCue(approvalPrompt(agentName, event.action), 'approval', turn);
  }

  /** Returns false for unknown or already decided approvals. */
  resolveApproval(
    id: string,
    decision: 'approve' | 'deny',
    by: 'voice' | 'tap' | 'timeout' | 'call_end' | 'stop',
    /** False when the agent settled it itself: nothing goes back to it. */
    notifyAgent = true,
  ): boolean {
    const turn = this.turn;
    if (turn?.approval?.id !== id || this.decidedApprovals.has(id)) return false;
    turn.approval.cancelTimeout();
    turn.approval = undefined;
    this.decidedApprovals.add(id);
    if (this.cue?.kind === 'approval') this.cutCue('superseded');
    if (notifyAgent)
      void this.options.adapter.decideApproval?.(turn.id, id, decision).catch(() => undefined);
    this.options.send({
      v: 1,
      type: 'approval_resolved',
      call_id: this.options.callId,
      approval_id: id,
      decision,
      by,
    });
    this.log('approval_decided', { turn_id: turn.id, decision, by });
    if (!turn.agentDone) {
      this.timer(turn, 'idle', this.timeouts.idleMs);
      turn.totalBudgetStartedAt = this.options.scheduler.now();
      this.timer(turn, 'total', turn.totalBudgetRemaining);
    }
    turn.lastTextAt = this.options.scheduler.now();
    this.scheduleProgress(turn);
    if (decision === 'deny' && (by === 'voice' || by === 'tap'))
      this.speakCue(APPROVAL_DENIED_LINE, 'approval');
    return true;
  }

  approvalStatus(id: string): 'pending' | 'decided' | 'unknown' {
    if (this.turn?.approval?.id === id) return 'pending';
    return this.decidedApprovals.has(id) ? 'decided' : 'unknown';
  }

  private handleApprovalSpeech(text: string, spokenFrom: number | undefined): void {
    const turn = this.turn;
    const approval = turn?.approval;
    if (approval === undefined || turn === undefined) return;
    const words = echoWords(text);
    const hasStopWord = words.some(
      (word, index) =>
        word === 'stop' ||
        word === 'cancel' ||
        word === 'nevermind' ||
        (word === 'never' && words[index + 1] === 'mind'),
    );
    if (hasStopWord && isStopRequest(text, this.options.agentName)) {
      this.resolveApproval(approval.id, 'deny', 'stop');
      this.stopRequested();
      return;
    }
    let decision = approvalVoiceDecision(text, this.options.agentName);
    // A yes the owner began before this question existed answered something else (the agent's own
    // "shall I go on?"): it must not approve what was asked meanwhile. A no is still a no.
    if (decision === 'approve' && spokenFrom !== undefined && spokenFrom < approval.askedAt) {
      this.log('approval_answer_predates', { turn_id: this.turn?.id });
      decision = undefined;
    }
    if (decision !== undefined) {
      this.resolveApproval(approval.id, decision, 'voice');
      return;
    }
    // A long new request waits behind the turn (ADR-026); a long answer that opens with a yes or a
    // no ("yes, go ahead and make it") is an answer, too long to trust: ask for a short one.
    const opensWithAnswer = words
      .slice(0, MAX_APPROVAL_WORDS)
      .some(
        (_, end) =>
          approvalVoiceDecision(words.slice(0, end + 1).join(' '), this.options.agentName) !==
          undefined,
      );
    if (words.length > MAX_APPROVAL_WORDS && !opensWithAnswer) {
      this.queueTurn(turn, text, spokenFrom ?? this.wallClock());
      return;
    }
    this.reaskApproval(approval);
  }

  private reaskApproval(approval: PendingApproval): boolean {
    if (!approval.reasked) {
      approval.reasked = true;
      this.cutCue('superseded');
      this.speakCue(APPROVAL_REASK, 'approval');
      return true;
    }
    return false;
  }

  /**
   * ADAPTERS §12: an agent that doesn't stream (it said so at connect, or a REST agent answered with
   * final JSON) gets one heads-up per call, on its first answered turn, that replies may be slower.
   * It rides alongside the reply; it is not a failure. Built-in test lines never get it.
   */
  private noticeIfNotStreaming(): void {
    if (this.notStreamingNoticeSent) return;
    const { adapter } = this.options;
    if (!NOT_STREAMING_NOTICE_ADAPTERS.has(adapter.name)) return;
    if (adapter.capabilities.streamingText) return;
    this.notStreamingNoticeSent = true;
    this.log('agent_not_streaming');
    this.options.send({
      v: 1,
      type: 'notice',
      call_id: this.options.callId,
      code: 'agent_not_streaming',
    });
  }

  private onText(turn: Turn, raw: string): void {
    const stripped = stripHangupMarkers(turn.markerCarry + raw, false);
    turn.markerCarry = stripped.carry;
    if (stripped.found) turn.hangupRequested = true;
    const delta = stripped.text;
    if (delta === '') return;
    if (!turn.firstTextLogged) {
      turn.firstTextLogged = true;
      this.log('agent_first_text', { turn_id: turn.id, duration_ms: this.since(turn) });
    }
    turn.lastTextAt = this.options.scheduler.now();
    this.scheduleProgress(turn);
    turn.visible += delta;
    this.scheduleText(turn);
    this.speak(turn, turn.filter.push(delta));
  }

  /**
   * Speaks `text` after anything held, or holds it: while the caller talks over a working agent, and
   * while an ended generation is still playing out (appending to it would be lost).
   */
  private speak(turn: Turn, text: string): void {
    if (turn.muted) return;
    if (turn.generationEnded || (this.callerHasFloor && turn.generationId === undefined)) {
      turn.heldSpeech += text;
      return;
    }
    const held = turn.heldSpeech;
    const pending = held + text;
    turn.heldSpeech = '';
    if (pending === '' || (pending.trim() === '' && turn.generationId === undefined)) return;
    if (turn.generationId === undefined) {
      // A Twring line about to end finishes first: a chopped "One mo-" sounds broken. The words
      // wait at most a moment (ADR-032 amendment).
      if (this.cueAlmostDone()) {
        turn.heldSpeech = pending;
        this.waitForCue(turn);
        return;
      }
      // The agent's own words win over Twring's line: it is cut, never overlapped (ADR-028).
      this.cutCue('superseded');
      turn.generationId = this.options.speech.begin(turn.committedAt);
      this.audibleGenerations(); // prunes generations no longer audible
      this.generations.push({ id: turn.generationId, text: '', played: false, finished: false });
    }
    // The held text now belongs to a generation: its boundary must not end a later one.
    if (held !== '') turn.heldBoundary = false;
    this.options.speech.append(turn.generationId, pending);
    const generation = this.generations.find((g) => g.id === turn.generationId);
    if (generation !== undefined) generation.text += pending;
  }

  /**
   * The agent paused speaking to act (tool call, activity): the words so far go out as one finished
   * generation, so the floor can show the activity once they have played, and caller noise in the
   * silence that follows is not a barge-in on speech that is already over.
   */
  private closeGeneration(turn: Turn): void {
    this.speak(turn, turn.filter.end());
    if (
      (turn.generationId === undefined || turn.generationEnded) &&
      turn.heldSpeech.trim() !== ''
    ) {
      turn.heldBoundary = true;
    }
    this.endGeneration(turn);
  }

  /** No more text for the open generation; it stays the turn's until it has played out. */
  private endGeneration(turn: Turn): void {
    if (turn.generationId === undefined || turn.generationEnded) return;
    turn.generationEnded = true;
    // May report 'finished' synchronously (nothing was sent): the flag is set first.
    this.options.speech.end(turn.generationId);
  }

  private clearGeneration(turn: Turn): void {
    turn.speaking = false;
    turn.generationId = undefined;
    turn.generationEnded = false;
  }

  /**
   * Once the agent is done and no generation is playing: speaks what is still held (unless the
   * caller is talking; their discard releases it, their commit drops it), or marks speech done.
   */
  private settleSpeech(turn: Turn): void {
    if (!turn.agentDone || turn.generationId !== undefined) return;
    if (!turn.muted && turn.heldSpeech.trim() !== '') {
      if (this.callerHasFloor) return;
      turn.heldBoundary = false;
      this.speak(turn, '');
      // The released text's generation finishing settles the turn again.
      this.endGeneration(turn);
      return;
    }
    turn.heldSpeech = '';
    turn.heldBoundary = false;
    turn.speechDone = true;
    this.maybeComplete(turn);
  }

  private setActivity(turn: Turn, activity: string | undefined): void {
    turn.activity = activity;
    this.updateFloor();
    // Something real to say: it need not wait for the long silence a generic line waits for.
    if (spokenActivityLabel(activity) !== undefined) this.scheduleProgress(turn);
  }

  private finishAgent(
    turn: Turn,
    outcome: 'completed' | 'failed' | 'timeout',
    failureNotice: 'agent_failed' | 'agent_unreachable' = 'agent_failed',
  ): void {
    if (turn.agentDone) return;
    if (turn.approval !== undefined) this.resolveApproval(turn.approval.id, 'deny', 'call_end');
    turn.agentDone = true;
    turn.activity = undefined;
    if (outcome === 'completed') this.counts.completed += 1;
    else this.counts.failed += 1;
    this.clearTimers(turn);
    // Text held back as a possible marker start was not one after all.
    const rest = stripHangupMarkers(turn.markerCarry, true).text;
    turn.markerCarry = '';
    if (rest !== '') {
      turn.visible += rest;
      this.speak(turn, turn.filter.push(rest));
    }
    this.speak(turn, turn.filter.end());
    this.sendText(turn, true);
    this.log('agent_turn_done', { turn_id: turn.id, outcome, duration_ms: this.since(turn) });
    if (outcome !== 'completed') {
      this.options.send({
        v: 1,
        type: 'notice',
        call_id: this.options.callId,
        code: outcome === 'timeout' ? 'agent_timeout' : failureNotice,
      });
      // Stop the agent working on a turn Twring has given up on.
      // A timeout goes on the wire as turn.cancel reason `timeout`.
      if (!turn.controller.signal.aborted)
        turn.controller.abort(new Error(outcome === 'timeout' ? 'timeout' : 'turn finished'));
    }
    this.endGeneration(turn);
    // Nothing is working any more: a progress line about it would no longer be true. Unless the
    // answer is waiting for that line's last moment: then the line ends and the answer follows.
    // (clearTimers above dropped the wait, but the speak() calls just above armed it again.)
    if (this.cue?.turnId === turn.id && !turn.timers.has('cue')) this.cutCue('superseded');
    // Held speech still has to be released (or superseded) before the turn is over.
    this.settleSpeech(turn);
  }

  /**
   * The caller started talking over this turn's speech: it stops now and never resumes, even if the
   * caller's speech proves to be noise. The agent keeps running until the caller commits a turn
   * (which supersedes it): a backchannel is not a reason to throw its work away.
   */
  private bargeIn(turn: Turn, pending: { startedAt: number; onsetAt: number | undefined }): void {
    const { startedAt, onsetAt } = pending;
    this.log('barge_in', {
      turn_id: turn.id,
      generation_id: turn.generationId,
      ...(onsetAt !== undefined && { detect_ms: Math.round(startedAt - onsetAt) }),
      confirm_ms: Math.round(this.options.scheduler.now() - startedAt),
    });
    turn.muted = true;
    this.counts.bargeIns += 1;
    this.generationEnded(turn.generationId, false);
    this.clearGeneration(turn);
    turn.heldSpeech = '';
    turn.heldBoundary = false;
    this.options.speech.cancel('barge_in');
    this.maybeComplete(turn);
  }

  /**
   * Nothing is holding speech back any more (the caller's speech was noise, or the previous
   * generation finished playing): what was held plays now.
   */
  private releaseHeldSpeech(turn: Turn): void {
    if (turn.muted || this.callerHasFloor || turn.generationId !== undefined) return;
    if (turn.agentDone) {
      this.settleSpeech(turn);
      return;
    }
    const boundary = turn.heldBoundary;
    turn.heldBoundary = false;
    this.speak(turn, '');
    if (boundary) this.endGeneration(turn);
  }

  /** The turn is over once the agent is done and its speech has played out (or was cut off). */
  private maybeComplete(turn: Turn): void {
    if (this.turn !== turn || !turn.agentDone || !(turn.speechDone || turn.muted)) return;
    this.turn = undefined;
    const queued = this.queued;
    if (queued !== undefined && !this.closed) {
      // ADR-026: what the owner said while the agent worked goes now (or with their next words, if
      // they are talking). It also wins over a hang-up marker in the answer just heard: the owner
      // still has something to say.
      if (turn.hangupRequested) queued.hangupSkipped = true;
      this.sendQueued();
      this.updateFloor();
      return;
    }
    this.updateFloor();
    // Hang up only after a reply the owner heard to the end; a barge-in means they want to talk.
    if (turn.hangupRequested && !turn.muted && !turn.yielded) this.scheduleHangup();
  }

  /**
   * The agent speaks first (an answered ring, ADR-024): `text` goes to the agent as the call's
   * first user turn. Ignored once any turn exists.
   */
  openingTurn(text: string, openingLine?: string): void {
    if (this.closed || this.turn !== undefined || this.turnCount > 0) return;
    this.log('opening_turn', { text_chars: text.length });
    this.commitTurn(text, this.wallClock(), 'opening', openingLine);
  }

  private clearHangup(): void {
    this.cancelHangup?.();
    this.cancelHangup = undefined;
    this.hangupDeferred = false;
  }

  /**
   * The agent's hang-up reply played out: the call ends after the lingering window. When the owner
   * is already talking (they started over the reply's tail), the window waits for them: their turn
   * cancels the hang-up, and speech that turns out to be noise starts the window then.
   */
  private scheduleHangup(): void {
    this.clearHangup();
    if (this.userSpeaking) {
      this.hangupDeferred = true;
      this.log('agent_hangup_deferred');
      return;
    }
    this.log('agent_hangup_requested', { linger_ms: AGENT_HANGUP_LINGER_MS });
    this.cancelHangup = this.options.scheduler.setTimeout(() => {
      this.cancelHangup = undefined;
      if (this.closed) return;
      this.log('agent_hangup');
      this.options.onAgentHangup?.();
    }, AGENT_HANGUP_LINGER_MS);
  }

  /** A new committed turn replaces the one in progress: its speech stops, its agent run too. */
  private supersede(): Turn | undefined {
    const turn = this.turn;
    if (turn === undefined) return undefined;
    this.turn = undefined;
    this.log('agent_turn_superseded', { turn_id: turn.id });
    this.stopTurn(turn, 'superseded');
    this.sendText(turn, true);
    return turn;
  }

  private stopTurn(turn: Turn, reason: 'superseded' | 'call_ended'): void {
    if (turn.approval !== undefined) this.resolveApproval(turn.approval.id, 'deny', 'call_end');
    this.clearTimers(turn);
    if (this.cue?.turnId === turn.id) this.cutCue(reason);
    this.generationEnded(turn.generationId, false);
    if (turn.generationId !== undefined) this.options.speech.cancel(reason);
    if (!turn.agentDone) {
      turn.controller.abort(new Error(reason));
      const { adapter } = this.options;
      if (adapter.capabilities.cancellation && adapter.cancelTurn !== undefined) {
        adapter.cancelTurn(turn.id, reason).catch(() => undefined);
      }
    }
  }

  /**
   * ADR-028: arms the "heard you" tone (owner turns only) and the first progress line; ADR-032:
   * the spoken acknowledgement (owner turns only).
   */
  private startPresence(turn: Turn, source: TurnSource): void {
    if (this.options.presenceCues !== true) return;
    if (source === 'owner') {
      this.presenceTimer(turn, 'tone', PRESENCE_TONE_AFTER_MS, () => this.playTone(turn));
      if (this.options.acknowledge === true && !turn.acked) {
        this.presenceTimer(turn, 'ack', ACK_LINE_AFTER_MS, () => this.acknowledge(turn));
      }
    }
    this.scheduleProgress(turn);
  }

  /**
   * One short "one moment" in the agent's voice, once, while the agent is still silent (ADR-032).
   * A moment missed (someone speaking, a line playing) is not made up later.
   */
  private acknowledge(turn: Turn): void {
    if (this.closed || this.turn !== turn || turn.agentDone || turn.muted || turn.yielded) return;
    if (turn.acked || turn.approval !== undefined || turn.visible !== '') return;
    if (
      turn.generationId !== undefined ||
      turn.heldSpeech.trim() !== '' ||
      this.userSpeaking ||
      this.utterance !== undefined ||
      this.heldShort !== undefined ||
      this.cue !== undefined
    )
      return;
    turn.acked = true;
    const line = ackLine(this.acks);
    this.acks += 1;
    const generationId = this.speakCue(line, 'ack', turn);
    this.log('ack_line', { turn_id: turn.id, generation_id: generationId });
  }

  /** The soft tone, once, if the agent has said nothing yet and nobody is speaking. */
  private playTone(turn: Turn): void {
    if (this.closed || this.turn !== turn || turn.agentDone || turn.muted) return;
    if (turn.visible !== '' || turn.generationId !== undefined || turn.heldSpeech !== '') return;
    if (this.userSpeaking || this.heldShort !== undefined || this.cue !== undefined) return;
    this.log('presence_tone', { turn_id: turn.id });
    this.options.speech.playTone?.();
  }

  /** Arms the turn's next progress line: after the silence, the repeat gap, and the cap. */
  private scheduleProgress(turn: Turn): void {
    if (turn.approval !== undefined) return;
    if (this.options.presenceCues !== true || turn.agentDone) return;
    if (turn.progressLines >= MAX_PROGRESS_LINES) return;
    let due = turn.lastTextAt + PROGRESS_LINE_AFTER_MS;
    if (turn.lastLineAt !== undefined)
      due = Math.max(due, turn.lastLineAt + PROGRESS_LINE_REPEAT_MS);
    if (turn.lastProgressCheckAt !== undefined)
      due = Math.max(due, turn.lastProgressCheckAt + PROGRESS_LINE_REPEAT_MS);
    if (turn.opening) due = Math.max(due, turn.committedAt + OPENING_TURN_QUIET_MS);
    const wait = Math.max(0, due - this.options.scheduler.now());
    this.presenceTimer(turn, 'progress', wait, () => this.progressDue(turn));
  }

  /**
   * One short line about what the agent is really doing, in its voice (ADR-028). Waits while
   * anyone is speaking; never for a turn the owner silenced, or once the agent is done.
   */
  private progressDue(turn: Turn): void {
    if (turn.approval !== undefined) return;
    if (this.closed || this.turn !== turn || turn.agentDone || turn.muted || turn.yielded) return;
    const busy =
      turn.generationId !== undefined ||
      turn.heldSpeech.trim() !== '' ||
      this.userSpeaking ||
      this.utterance !== undefined ||
      this.heldShort !== undefined ||
      this.cue !== undefined;
    if (busy) {
      this.presenceTimer(turn, 'progress', PROGRESS_LINE_RECHECK_MS, () => this.progressDue(turn));
      return;
    }
    const now = this.options.scheduler.now();
    if (now - turn.lastTextAt < PROGRESS_LINE_AFTER_MS) {
      this.scheduleProgress(turn);
      return;
    }
    const label = spokenActivityLabel(turn.activity);
    if (label === undefined && now - turn.lastTextAt < GENERIC_PROGRESS_LINE_AFTER_MS) {
      // Nothing real to say yet: "Still working on it." only after a long silence.
      this.presenceTimer(
        turn,
        'progress',
        turn.lastTextAt + GENERIC_PROGRESS_LINE_AFTER_MS - now,
        () => this.progressDue(turn),
      );
      return;
    }
    if (
      (label === undefined &&
        (turn.genericProgressSaid || turn.lastSpokenProgressLabel !== undefined)) ||
      (label !== undefined && label === turn.lastSpokenProgressLabel)
    ) {
      turn.lastProgressCheckAt = now;
      this.scheduleProgress(turn);
      return;
    }
    const labelKind = label === undefined ? 'generic' : (turn.activityKind ?? 'activity');
    if (label === undefined) turn.genericProgressSaid = true;
    else turn.lastSpokenProgressLabel = label;
    turn.progressLines += 1;
    turn.lastLineAt = now;
    this.log('progress_line', {
      turn_id: turn.id,
      label_kind: labelKind,
      line: turn.progressLines,
    });
    this.speakCue(progressLine(turn.activity), 'progress', turn);
    this.scheduleProgress(turn);
  }

  /** Speaks `text` as Twring's own line through the normal TTS path: echo-matched, barge-in-able. */
  private speakCue(text: string, kind: Cue['kind'], turn?: Turn): string | undefined {
    // The agent's own words win over Twring's line (ADR-028). Beginning a line would also cut that
    // speech in the pipeline without the turn ever hearing it finished.
    if (this.turn?.generationId !== undefined) {
      this.log('presence_cue_skipped', { kind });
      return undefined;
    }
    const { speech, scheduler } = this.options;
    // Timed from now: the pipeline's first-audio figure is about the agent's answer, not this line.
    const generationId = speech.begin(scheduler.now());
    this.audibleGenerations(); // prunes generations no longer audible
    this.generations.push({ id: generationId, text, played: false, finished: false, cue: true });
    this.cue = { generationId, kind, ...(turn !== undefined && { turnId: turn.id }) };
    speech.append(generationId, text);
    speech.end(generationId);
    return generationId;
  }

  /** Twring's line (not an approval or "Okay, stopped.") is playing and has at most a moment left. */
  private cueAlmostDone(): boolean {
    const cue = this.cue;
    if (cue === undefined || (cue.kind !== 'ack' && cue.kind !== 'progress')) return false;
    const { speech } = this.options;
    const total = speech.totalAudioMs(cue.generationId);
    const played = speech.playedMs(cue.generationId);
    return total !== undefined && played > 0 && total - played <= CUE_FINISH_GRACE_MS;
  }

  /** The agent's words wait for the line's end, or are released (and the line cut) a moment later. */
  private waitForCue(turn: Turn): void {
    if (turn.timers.has('cue')) return;
    const waited = this.cue?.generationId;
    this.presenceTimer(turn, 'cue', CUE_FINISH_GRACE_MS + 200, () => {
      // Only the line it waited for: never a later one, such as an approval question.
      if (this.cue?.generationId === waited) this.cutCue('superseded');
      this.releaseHeldSpeech(turn);
    });
  }

  /** Stops Twring's own line now, if one is playing. */
  private cutCue(reason: 'barge_in' | 'superseded' | 'call_ended'): void {
    const cue = this.cue;
    if (cue === undefined) return;
    this.cue = undefined;
    const playedMs = this.options.speech.playedMs(cue.generationId);
    this.generationEnded(cue.generationId, false);
    this.options.speech.cancel(reason);
    this.log('presence_cue_cut', { kind: cue.kind, reason, played_ms: playedMs });
  }

  private presenceTimer(
    turn: Turn,
    name: 'tone' | 'progress' | 'ack' | 'cue',
    ms: number,
    callback: () => void,
  ): void {
    turn.timers.get(name)?.();
    turn.timers.set(
      name,
      this.options.scheduler.setTimeout(() => {
        turn.timers.delete(name);
        callback();
      }, ms),
    );
  }

  private scheduleText(turn: Turn): void {
    if (turn.textTimer !== undefined) return;
    const wait = turn.lastTextSentAt + TEXT_UPDATE_MS - this.options.scheduler.now();
    if (wait <= 0) {
      this.sendText(turn, false);
      return;
    }
    turn.textTimer = this.options.scheduler.setTimeout(() => {
      turn.textTimer = undefined;
      if (this.turn === turn) this.sendText(turn, false);
    }, wait);
  }

  private sendText(turn: Turn, final: boolean): void {
    turn.textTimer?.();
    turn.textTimer = undefined;
    if (turn.visible === '' && !final) return;
    turn.lastTextSentAt = this.options.scheduler.now();
    // With controls gone and lone surrogates replaced, every UTF-16 unit is at most 3 bytes in
    // JSON, so a full-length caption fits one status packet (MAX_STATUS_MESSAGE_BYTES).
    const visible = turn.visible.replace(CONTROL_CHARS, '').replace(LONE_SURROGATE, '�');
    let text = visible;
    if (visible.length > MAX_VISIBLE_CHARS) {
      let start = visible.length - MAX_VISIBLE_CHARS + 1;
      // Clip on a code-point boundary: never start with the low half of a surrogate pair.
      if (/[\uDC00-\uDFFF]/.test(visible[start] ?? '')) start += 1;
      text = `…${visible.slice(start)}`;
    }
    this.options.send({
      v: 1,
      type: 'agent_text',
      call_id: this.options.callId,
      turn_id: turn.id,
      text,
      final,
    });
  }

  private updateFloor(): void {
    const turn = this.turn;
    const next: Floor =
      turn === undefined || this.callerHasFloor || turn.yielded || this.heldShort !== undefined
        ? { floor: this.callerHasFloor ? 'user_speaking' : 'listening' }
        : turn.speaking
          ? { floor: 'agent_speaking', turn_id: turn.id }
          : {
              floor: 'agent_working',
              turn_id: turn.id,
              ...(turn.activity !== undefined && { activity: turn.activity }),
            };
    if (
      next.floor === this.floor.floor &&
      next.turn_id === this.floor.turn_id &&
      next.activity === this.floor.activity
    ) {
      return;
    }
    this.floor = next;
    this.floorSeq += 1;
    this.sendFloor();
  }

  private sendFloor(): void {
    if (this.closed) return;
    this.options.send({
      v: 1,
      type: 'floor',
      call_id: this.options.callId,
      seq: this.floorSeq,
      ...this.floor,
    });
  }

  private timer(turn: Turn, budget: Budget, ms: number): void {
    this.cancelTimer(turn, budget);
    turn.timers.set(
      budget,
      // Ends the turn directly: an adapter that ignores its abort signal cannot hold the floor.
      this.options.scheduler.setTimeout(() => {
        turn.timers.delete(budget);
        if (this.turn !== turn || turn.agentDone) return;
        this.log('agent_timeout', { turn_id: turn.id, budget });
        this.finishAgent(turn, 'timeout');
      }, ms),
    );
  }

  private cancelTimer(turn: Turn, budget: Budget): void {
    turn.timers.get(budget)?.();
    turn.timers.delete(budget);
  }

  private clearTimers(turn: Turn): void {
    for (const cancel of turn.timers.values()) cancel();
    turn.timers.clear();
    turn.textTimer?.();
    turn.textTimer = undefined;
  }

  private since(turn: Turn): number {
    return Math.round(this.options.scheduler.now() - turn.committedAt);
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    this.options.logger.info({ event, call_id: this.options.callId, ...fields });
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
