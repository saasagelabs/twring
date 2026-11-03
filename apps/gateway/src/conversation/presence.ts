/**
 * Presence cues while the agent works (ADR-028): no dead air between the owner's turn and the
 * agent's first word. Only what the agent's own events support is ever said; never progress
 * figures or promises ("almost done").
 */

/** A committed turn with no agent text this long gets the soft "heard you" tone. */
export const PRESENCE_TONE_AFTER_MS = 700;
/** A working turn with no agent text (or progress line) this long gets a spoken progress line. */
export const PROGRESS_LINE_AFTER_MS = 4_000;
/**
 * With nothing the agent's events name, "Still working on it." waits this long (owner, 2026-10-24):
 * a short wait has already had "One moment.", and a second line soon after is noise.
 */
export const GENERIC_PROGRESS_LINE_AFTER_MS = 12_000;
/** A Twring line this close to its end finishes before the agent's first words, instead of being cut. */
export const CUE_FINISH_GRACE_MS = 500;
/** Shortest gap between two progress lines of one turn. */
export const PROGRESS_LINE_REPEAT_MS = 15_000;
/** Most progress lines one turn ever gets. */
export const MAX_PROGRESS_LINES = 4;
/** A due progress line that cannot play yet (someone is speaking) is looked at again this soon. */
export const PROGRESS_LINE_RECHECK_MS = 1_000;
/** No progress line in an answered ring's opening turn before this (the agent speaks first). */
export const OPENING_TURN_QUIET_MS = 2_000;

/** An owner turn with no agent text this long gets one short spoken acknowledgement (ADR-032). */
export const ACK_LINE_AFTER_MS = 1_500;
/** Twring's acknowledgements, in the agent's voice: they say "heard you", never anything about the work. */
// None of them is a stop-talking phrase (FLOOR_CONTROL_WORDS): an echo of one must never read as
// the owner asking to wait.
export const ACK_LINES = ['Okay, one moment.', 'Sure, let me see.', 'Right, let me think.'];

/** The call's `n`th acknowledgement: they take turns, so two in a row never match. */
export function ackLine(n: number): string {
  return ACK_LINES[n % ACK_LINES.length] ?? ACK_LINES[0]!;
}

/** Spoken when the agent's events name nothing safe to say. */
export const GENERIC_PROGRESS_LINE = 'Still working on it.';
/** Spoken by Twring (not the agent) once a stop request cancelled a working turn. */
export const STOPPED_LINE = 'Okay, stopped.';

/** Longest activity label spoken; a longer one falls back to the generic line rather than be cut. */
export const MAX_SPOKEN_LABEL_CHARS = 40;

/** Control, bidi and invisible characters (as the phone's activity line drops them). */
const UNSAFE_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\x00-\x1f\x7f-\x9f\u{61c}\u{200b}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{2028}\u{2029}\u{2060}\u{feff}]/gu;

/** Words that would claim progress the events don't support. */
const PROGRESS_CLAIM = /\b(almost|nearly|done|finished|complete|completed|percent)\b/i;

/** snake_case, dotted, camelCase, paths, or call-shaped words: a tool name, not a phrase. */
function looksLikeIdentifier(text: string): boolean {
  return text.split(' ').some((word) => /_|\(|\)|^[a-z]+[A-Z]|\w\.\w|\/|::/.test(word));
}

/**
 * The activity label as a phrase safe to speak, or undefined when there is none: generic
 * ("Working…"), tool-name shaped, markup, digits or progress claims, or too long to say whole.
 */
export function spokenActivityLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const text = label
    .replace(UNSAFE_CHARACTERS, ' ')
    .replace(/[<>`*#[\]{}|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.,;:!?…-]+$/u, '');
  if (text === '' || /^working$/i.test(text)) return undefined;
  if (looksLikeIdentifier(text) || /[\d%]/.test(text) || PROGRESS_CLAIM.test(text))
    return undefined;
  if (!/^[\p{L}][\p{L}\s',-]*$/u.test(text)) return undefined;
  if (Array.from(text).length > MAX_SPOKEN_LABEL_CHARS) return undefined;
  // "Running a command" → "running a command"; an acronym ("NPM install") keeps its case.
  const second = text.charAt(1);
  return second !== '' && second === second.toUpperCase() && /\p{L}/u.test(second)
    ? text
    : text.charAt(0).toLowerCase() + text.slice(1);
}

/** The progress line for what the agent is doing now. */
export function progressLine(label: string | undefined): string {
  const spoken = spokenActivityLabel(label);
  return spoken === undefined ? GENERIC_PROGRESS_LINE : `Still working: ${spoken}.`;
}
