import type { TwringApi } from '@/api';

import type { SecureKeyValue } from '../auth/storage';
import { rewrapApi } from './pair-api';
import { hasRewrapWork, runRewrapJobs } from './rewrap';

/**
 * Runs this phone's unfinished re-wrap jobs (C3 #11 Task 28) for the private chats given: after
 * an approve, and when the app opens with work left. Never throws; logs carry counts only.
 */
export async function shareHistory(
  api: Pick<TwringApi, 'listMessages' | 'getAgent'>,
  store: SecureKeyValue,
  privateAgentIds: readonly string[],
): Promise<void> {
  try {
    if (!(await hasRewrapWork(store))) return;
  } catch {
    return;
  }
  await runRewrapJobs({
    store,
    api: rewrapApi(),
    // A chat whose address cannot be read (offline) fails the run, so the job waits for the
    // next open instead of finishing without that chat.
    privateChats: () =>
      Promise.all(
        privateAgentIds.map(async (agentId) => ({
          agentId,
          address: (await api.getAgent(agentId)).endpoint_url,
        })),
      ),
    messages: (agentId, beforeSeq) =>
      api.listMessages(agentId, { ...(beforeSeq !== undefined && { beforeSeq }), limit: 100 }),
  });
}
