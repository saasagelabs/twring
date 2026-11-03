import {
  MAX_AGENT_KEYTERMS,
  connectorWordsResponseSchema,
  errorResponseSchema,
} from '@twring/contracts';

import { apiUrl, checkServerUrl, type ConnectorConfig } from './config';
import { envSessionScope, pickAgent, withTimeout, type FetchFn } from './ring';

/**
 * `twring-connect words`: the agent teaches its calls words to hear right (the owner's name,
 * people, projects, places). They go after the owner's own on the agent's Words page.
 */

export const WORDS_EXIT = { added: 0, error: 1 } as const;

const REQUEST_TIMEOUT_MS = 15_000;

export async function addWords(
  config: ConnectorConfig,
  options: { words: readonly string[]; agent?: string; scope?: string | undefined },
  deps: { print: (line: string) => void; fetch?: FetchFn; signal?: AbortSignal },
): Promise<number> {
  const agent = pickAgent(config, options.agent);
  if (agent === undefined) {
    deps.print(
      `No agent "${options.agent ?? ''}" on this computer. Paired agents: ${config.agents.map((a) => a.id).join(', ')}.`,
    );
    return WORDS_EXIT.error;
  }
  const words = options.words.map((word) => word.trim()).filter((word) => word !== '');
  if (words.length === 0) {
    deps.print('Say which words, e.g. twring-connect words "Gowri" "Lightsail"');
    return WORDS_EXIT.error;
  }
  const server = checkServerUrl(config.server);
  const scope = 'scope' in options ? options.scope : envSessionScope();
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(apiUrl(server, '/v1/connectors/words'), {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        local_agent: agent.id,
        words,
        ...(scope !== undefined && { session_scope: scope }),
      }),
      redirect: 'error',
      signal: withTimeout(deps.signal, REQUEST_TIMEOUT_MS),
    });
  } catch {
    deps.print(`Could not reach ${server.origin}. Check your internet connection.`);
    return WORDS_EXIT.error;
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const parsed = connectorWordsResponseSchema.safeParse(body);
    if (!parsed.success) {
      deps.print('Twring answered in a way this version does not understand. Update it.');
      return WORDS_EXIT.error;
    }
    deps.print(
      `From the next call or voice note, Twring will listen for: ${parsed.data.words.join(', ')}.`,
    );
    if (parsed.data.not_added.length > 0) {
      deps.print(
        `The list is full (${MAX_AGENT_KEYTERMS} words); not added: ${parsed.data.not_added.join(', ')}. Remove words on the agent’s Words page in the Twring app.`,
      );
    }
    return WORDS_EXIT.added;
  }
  const refusal = errorResponseSchema.safeParse(body);
  // A server without this route answers its generic not_found; agent_not_saved has its own words.
  if (response.status === 404 && (!refusal.success || refusal.data.error.code === 'not_found'))
    deps.print("This Twring server can't take words yet. Update it, or ask its owner.");
  else if (refusal.success) deps.print(refusal.data.error.message);
  else deps.print(`Could not add the words (HTTP ${response.status}).`);
  return WORDS_EXIT.error;
}
