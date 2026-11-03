import {
  agentKeytermSchema,
  MAX_AGENT_KEYTERM_LENGTH,
  MAX_AGENT_KEYTERMS,
} from '@twring/contracts';

export type AddKeytermResult = { ok: true; terms: string[] } | { ok: false; error: string };

/** Commas, semicolons, and line breaks separate words: "Chennai, Vellore" is two entries. */
const SEPARATORS = /[,;\n\r，、]/;

/** Splits entries typed or saved as one comma-separated list into separate words. */
export function splitKeyterms(terms: readonly string[]): string[] {
  const out: string[] = [];
  for (const term of terms) {
    for (const part of term.split(SEPARATORS)) {
      const word = part.trim().normalize('NFC');
      if (word !== '' && !out.some((e) => e.toLowerCase() === word.toLowerCase())) out.push(word);
    }
  }
  return out;
}

/**
 * Adds what was typed to the list, with the same rules the gateway enforces, in plain words. A
 * comma-separated list adds each word; words already on the list are skipped.
 */
export function addKeyterm(terms: readonly string[], input: string): AddKeytermResult {
  // The same canonical (trimmed, NFC) form the gateway stores, so duplicates compare equal.
  const words = splitKeyterms([input]);
  if (words.length === 0) return { ok: false, error: 'Type a word or name first.' };
  const next = [...terms];
  for (const term of words) {
    if (term.length > MAX_AGENT_KEYTERM_LENGTH) {
      return {
        ok: false,
        error: `Keep each one under ${MAX_AGENT_KEYTERM_LENGTH + 1} characters.`,
      };
    }
    if (!agentKeytermSchema.safeParse(term).success) {
      return { ok: false, error: 'Use ordinary letters, numbers, and symbols.' };
    }
    if (next.some((existing) => existing.toLowerCase() === term.toLowerCase())) {
      if (words.length === 1) return { ok: false, error: `${term} is already on the list.` };
      continue;
    }
    if (next.length >= MAX_AGENT_KEYTERMS) {
      return {
        ok: false,
        error: `You can add up to ${MAX_AGENT_KEYTERMS} words. Remove one first.`,
      };
    }
    next.push(term);
  }
  if (next.length === terms.length) return { ok: false, error: 'Those are already on the list.' };
  return { ok: true, terms: next };
}

export function removeKeyterm(terms: readonly string[], term: string): string[] {
  return terms.filter((existing) => existing !== term);
}

/** The detail-screen summary: the first few words, or a prompt when there are none. */
export function keytermSummary(terms: readonly string[]): string {
  if (terms.length === 0) return 'None yet';
  const shown = terms.slice(0, 3).join(', ');
  return terms.length > 3 ? `${shown} +${terms.length - 3}` : shown;
}

export function sameKeyterms(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((term, i) => term === b[i]);
}
