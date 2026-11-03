import type { CallErrorCode, CallState, NoticeMessage } from '@twring/contracts';

/** Failures that mean the call never got going, whenever they are reported. */
const NEVER_CONNECTED: ReadonlySet<CallErrorCode> = new Set<CallErrorCode>([
  'CALL_SESSION_CREATE_FAILED',
  'LIVEKIT_CONNECT_FAILED',
  'GATEWAY_UNAVAILABLE',
  'AGENT_CONNECT_FAILED',
  'AGENT_OFFLINE',
  'AGENT_NOT_ON_COMPUTER',
  'CONNECTOR_REMOVED',
  'CALL_IN_PROGRESS',
  'MIC_PERMISSION_DENIED',
  'MIC_UNAVAILABLE',
  'AUDIO_UNAVAILABLE',
  'AUDIO_UNREACHABLE',
  'AUDIO_PAUSED',
  'AUDIO_EXPIRED',
  'AUDIO_LIMIT_REACHED',
]);

/**
 * User-facing status text (CALL_STATE_MACHINE §14). No protocol jargon. `connectedAt` is when the
 * call first reached a connected state, if it did: a failure before that "didn't connect".
 */
export function statusLabel(state: CallState, connectedAt?: number): string {
  switch (state.status) {
    case 'IDLE':
      return '';
    case 'PREPARING':
      return 'Starting call…';
    case 'CONNECTING':
      return 'Connecting…';
    case 'LISTENING':
    case 'USER_SPEAKING':
      return 'Listening';
    case 'AGENT_WORKING':
      return 'Working…';
    case 'AGENT_SPEAKING':
      return 'Speaking';
    case 'RECONNECTING':
      return 'Reconnecting…';
    case 'ENDING':
      return 'Ending…';
    case 'ENDED':
      return 'Call ended';
    case 'FAILED':
      return connectedAt === undefined || NEVER_CONNECTED.has(state.error.code)
        ? "Call didn't connect"
        : 'Call interrupted';
  }
}

/** Longest activity line shown under the status; longer labels are cut at a word. */
export const ACTIVITY_MAX_CHARS = 40;

/**
 * The agent's activity, shown calmly under "Working…" (UX_UI_SPEC §12). Plain text only, one
 * line, and never something that looks like a raw tool or function name (those are diagnostics):
 * such labels are dropped and the status alone says "Working…".
 */
export function activityText(state: CallState): string | undefined {
  if (state.status !== 'AGENT_WORKING' || state.activity === undefined) return undefined;
  // Control characters (C0, C1), bidi controls, invisible breaks, and markup punctuation become
  // spaces: agent text is never markup here, and may not reorder or hide what the line says.
  const text = Array.from(state.activity, (char) =>
    UNSAFE_ACTIVITY_CHARACTERS.test(char) || '<>`*#[]{}|'.includes(char) ? ' ' : char,
  )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '' || /^working\W*$/i.test(text) || looksLikeIdentifier(text)) return undefined;
  // Counted and cut in code points, so an emoji is never split into a broken half.
  const chars = Array.from(text);
  if (chars.length <= ACTIVITY_MAX_CHARS) return text;
  const head = chars.slice(0, ACTIVITY_MAX_CHARS - 1).join('');
  const cut = head.lastIndexOf(' ');
  return `${(cut > ACTIVITY_MAX_CHARS / 2 ? head.slice(0, cut) : head).replace(/[\s.,;:…-]+$/, '')}…`;
}

/** C0/C1 controls, bidi controls, zero-width space, word joiner, BOM, line/paragraph separators. */
const UNSAFE_ACTIVITY_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\x00-\x1f\x7f-\x9f\u{61c}\u{200b}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{2028}\u{2029}\u{2060}\u{feff}]/u;

/** snake_case, dotted, camelCase, or call-shaped words: a tool name, not a sentence. */
function looksLikeIdentifier(text: string): boolean {
  return text.split(' ').some((word) => /_|\(|\)|^[a-z]+[A-Z]|\w\.\w|\/|::/.test(word));
}

/**
 * What to tell the caller about their agent (UX_UI_SPEC §19): the last turn got no answer, or
 * (shown alongside the reply, once per call) the agent doesn't stream (ADAPTERS §12).
 */
export function noticeText(code: NoticeMessage['code']): string {
  switch (code) {
    case 'agent_not_streaming':
      return "This agent doesn't stream, so replies may take longer.";
    case 'agent_failed':
      return "The agent couldn't answer that. Try saying it again.";
    case 'agent_timeout':
      return "The agent didn't answer in time. Try saying it again.";
    case 'agent_unreachable':
      return "Couldn't reach your agent. Try again in a moment.";
  }
}

/** mm:ss, or h:mm:ss past an hour. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Below this peak level the gateway is effectively hearing silence. */
export const SPEECH_FLOOR_DBFS = -50;
/** Level stats older than this are stale (the gateway sends one per second). */
export const INBOUND_STALE_MS = 2500;

/** 0…1 meter position for a peak level, over a -60…0 dBFS range. */
export function meterLevel(peakDbfs: number): number {
  return Math.min(1, Math.max(0, (peakDbfs + 60) / 60));
}
