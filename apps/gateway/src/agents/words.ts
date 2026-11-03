/**
 * An agent teaches its calls words to hear right (names, projects, places): they go after the
 * owner's own on the Words page, once each (any case), up to the list's limit.
 */
import { MAX_AGENT_KEYTERMS } from '@twring/contracts';

import { revisionOf, type AgentRecord, type AgentRepository } from '../store/repositories';

export type AddWordsResult =
  | { ok: true; words: string[]; notAdded: string[] }
  /** The agent is gone. */
  | { ok: false; reason: 'not_found' }
  /** The list kept changing under this write (two tries); nothing of it was lost. */
  | { ok: false; reason: 'busy' };

/** The words a shared agent learned in this person's own session (not the owner's list). */
export function personWords(agent: AgentRecord, personId: string): string[] {
  return agent.person_keyterms?.find((entry) => entry.person_id === personId)?.words ?? [];
}

/** What a person's calls to the agent listen for: the owner's words, then their own. */
export function callWords(agent: AgentRecord, personId: string): string[] {
  const words = [...(agent.keyterms ?? [])];
  const seen = new Set(words.map((word) => word.toLowerCase()));
  for (const word of agent.user_id === personId ? [] : personWords(agent, personId)) {
    if (seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    words.push(word);
  }
  return words;
}

export async function addAgentWords(
  agents: AgentRepository,
  userId: string,
  /** Reads the agent fresh: called again when the owner changed it meanwhile. */
  find: () => Promise<AgentRecord | undefined>,
  words: readonly string[],
  now: Date,
  /** Self-hosted shared agents: a team member's own list instead of the owner's. */
  personId?: string,
): Promise<AddWordsResult> {
  // Two tries: a change the owner made meanwhile is kept, never overwritten.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const agent = await find();
    if (agent === undefined) return { ok: false, reason: 'not_found' };
    const current = personId === undefined ? (agent.keyterms ?? []) : personWords(agent, personId);
    const merged = [...current];
    const seen = new Set(merged.map((word) => word.toLowerCase()));
    const notAdded: string[] = [];
    for (const word of words) {
      if (seen.has(word.toLowerCase())) continue;
      seen.add(word.toLowerCase());
      if (merged.length < MAX_AGENT_KEYTERMS) merged.push(word);
      else notAdded.push(word);
    }
    // Nothing new: no write, so the list's revision (and the owner's open edit) stays as it is.
    if (merged.length === current.length) return { ok: true, words: merged, notAdded };
    const patch =
      personId === undefined
        ? { keyterms: merged }
        : {
            person_keyterms: [
              ...(agent.person_keyterms ?? []).filter((entry) => entry.person_id !== personId),
              { person_id: personId, words: merged },
            ].slice(-500),
          };
    const updated = await agents.update(
      userId,
      agent.id,
      { ...patch, ifRevision: revisionOf(agent) },
      now,
    );
    if (updated !== undefined) return { ok: true, words: merged, notAdded };
  }
  return { ok: false, reason: 'busy' };
}
