import { type Agent, agentListResponseSchema } from '@twring/contracts';

import { withKnownAgentVoices } from '../api/client';
import type { ResourceCache } from '../hooks/useResource';
import { currentScope } from '../threads/chats';
import { fileStore, type JsonStore } from '../threads/outbox-storage';

/** The quiet line shown instead of the error when the list on screen is the saved one. */
export const OFFLINE_SAVED_AGENTS = 'No connection. Showing your agents from last time.';

/** A saved agent list, read the way the server's reply is; undefined when it does not parse. */
export function parseSavedAgents(saved: unknown): Agent[] | undefined {
  const parsed = agentListResponseSchema.safeParse(withKnownAgentVoices(saved));
  return parsed.success ? parsed.data.agents : undefined;
}

/**
 * The last agent list this account loaded from this server, so an offline start still shows the
 * agents. Nothing is read or saved before the signed-in account is known.
 */
export function agentCache(
  scope: () => string | undefined = currentScope,
  store: (scope: string) => JsonStore = (key) => fileStore('agents', key),
): ResourceCache<Agent[]> {
  return {
    async load() {
      const key = scope();
      if (key === undefined) return undefined;
      try {
        return parseSavedAgents(await store(key).load());
      } catch {
        return undefined;
      }
    },
    saver() {
      const key = scope();
      return (agents) => {
        // The scope the load started under: a switch meanwhile drops the save.
        if (key === undefined || scope() !== key) return;
        void store(key)
          .save({ agents })
          .catch(() => undefined);
      };
    },
  };
}
