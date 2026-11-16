import type { ApprovalAction } from '@twring/contracts';

import { echoWords } from './echo';
import { LINES, SPOKEN_APPROVAL_WORDS, type LineLanguage } from './lines';

export const APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_APPROVAL_WORDS = 4;
export const UNKNOWN_AGENT_NAME = 'Your agent';
export const APPROVAL_REASK = LINES.en.approvalReask;
export const APPROVAL_TIMEOUT_LINE = LINES.en.approvalTimeout;
export const APPROVAL_DENIED_LINE = LINES.en.approvalDenied;
export const APPROVAL_PHRASES: Record<ApprovalAction, string> = {
  edit_files: 'change files',
  delete_files: 'delete files',
  run_command: 'run a command',
  read_files: 'read files',
  fetch_web: 'open a web page',
  other: 'do something that needs your OK',
};
export function approvalPrompt(
  agentName: string,
  action: ApprovalAction,
  language: LineLanguage = 'en',
): string {
  return LINES[language].approvalPrompt(agentName, action);
}
const YES = [
  'yes',
  'yeah',
  'yep',
  'yup',
  'allow',
  'approve',
  'approved',
  'go ahead',
  'do it',
  'ok',
  'okay',
  'sure',
  'fine',
];
const NO = ['no', 'nope', 'deny', "don't", 'do not', 'dont', 'not now', 'never'];
/** Words allowed around a yes or no without changing it ("yes please", "no thanks"). */
const FILLERS = ['please', 'just', 'hey', 'thanks', 'thank you'];

/** Shown when the agent's own title is empty once cleaned. */
const FALLBACK_TITLES: Record<ApprovalAction, string> = {
  edit_files: 'Change files',
  delete_files: 'Delete files',
  run_command: 'Run a command',
  read_files: 'Read files',
  fetch_web: 'Open a web page',
  other: 'Approve an action',
};

/**
 * Controls, bidi overrides, invisible characters, and lone surrogates: on the phone card they could
 * disguise what the agent asks for (a right-to-left override reverses a file name).
 */
const UNSAFE_TEXT =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- strips controls and invisible Unicode from agent text
  /[\x00-\x1f\x7f-\x9f\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Agent text for the phone card, whatever adapter it came from. */
export function cleanApprovalText(text: string): string {
  return text.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
}

/** The agent's title, cleaned; a fixed one for the action when nothing is left. */
export function approvalTitle(title: string, action: ApprovalAction): string {
  return cleanApprovalText(title) || FALLBACK_TITLES[action];
}

const byLength = (phrases: string[]) => phrases.map(echoWords).sort((a, b) => b.length - a.length);
const FILLER_PATTERNS = byLength(FILLERS);

/** Yes and no patterns for a language: English always counts ("okay" works in any call). */
const DECISION_PATTERNS = new Map<LineLanguage, { yes: string[][]; no: string[][] }>();
function decisionPatterns(language: LineLanguage): { yes: string[][]; no: string[][] } {
  let patterns = DECISION_PATTERNS.get(language);
  if (patterns === undefined) {
    const extra = SPOKEN_APPROVAL_WORDS[language];
    patterns = {
      yes: byLength([...YES, ...(extra?.yes ?? [])]),
      no: byLength([...NO, ...(extra?.no ?? [])]),
    };
    DECISION_PATTERNS.set(language, patterns);
  }
  return patterns;
}
export function approvalVoiceDecision(
  text: string,
  agentName?: string,
  language: LineLanguage = 'en',
): 'approve' | 'deny' | undefined {
  const words = echoWords(text);
  if (words.length === 0 || words.length > MAX_APPROVAL_WORDS) return undefined;
  const names = new Set(echoWords(agentName ?? ''));
  const rest = words.filter((word) => !names.has(word));
  /** `rest` is one or more of `patterns`, with fillers allowed around them. */
  const matches = (patterns: string[][]) => {
    const at = (pattern: string[], index: number) =>
      pattern.every((word, offset) => rest[index + offset] === word);
    let index = 0;
    let found = false;
    while (index < rest.length) {
      const pattern = patterns.find((part) => at(part, index));
      if (pattern !== undefined) found = true;
      const step = pattern ?? FILLER_PATTERNS.find((part) => at(part, index));
      if (step === undefined) return false;
      index += step.length;
    }
    return found;
  };
  const { yes, no } = decisionPatterns(language);
  if (matches(yes)) return 'approve';
  if (matches(no)) return 'deny';
  return undefined;
}
