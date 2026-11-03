import { parseConnectorEndpoint } from '@twring/contracts';

import type { ConnectorHub } from '../connectors/hub';
import { revisionOf, type AgentRecord, type Stores } from '../store/repositories';

/**
 * Wave 1, track 2.3: whether a contact's old computer is gone, so the same computer linked again
 * may take the contact over.
 */

/** A listed computer offline at least this long counts as gone. */
export const RELINK_OFFLINE_MS = 10 * 60_000;

export function computerGone(options: {
  /** The contact's computer, or undefined once it was removed. */
  oldComputer: { name: string; last_seen_at?: string } | undefined;
  /** The name kept on the contact when its computer was removed. */
  contactComputerName: string | undefined;
  /** The newly linked computer's name. */
  newName: string;
  online: boolean;
  /** When this server last saw the old computer drop, if it has since it started. */
  droppedAt: number | undefined;
  now: number;
}): boolean {
  const { oldComputer } = options;
  if (oldComputer === undefined) return options.contactComputerName === options.newName;
  if (oldComputer.name !== options.newName || options.online) return false;
  // Two computers can share a name: a short disconnect must not hand one's contact to the other.
  // The clock runs from when it dropped; the last hello is the fallback after a restart.
  const lastSeen = Math.max(
    options.droppedAt ?? -Infinity,
    oldComputer.last_seen_at === undefined ? -Infinity : Date.parse(oldComputer.last_seen_at),
  );
  return options.now - lastSeen >= RELINK_OFFLINE_MS;
}

export interface RelinkDeps {
  stores: Pick<Stores, 'agents' | 'connectors'>;
  hub: Pick<ConnectorHub, 'isOnline' | 'droppedAt'> | undefined;
  now: () => Date;
  log: { info(fields: object, message: string): void };
}

/**
 * Wave 1, track 2.3: adding an agent from a newly linked computer reuses the one contact for that
 * agent whose computer has the same name and is removed or offline (its link was lost), keeping
 * its chats and history. Nothing is guessed: no match, or more than one, makes a new contact
 * (undefined). Shared by the phone's create route and the server-made link code's claim.
 */
export async function relinkConnectorContact(
  deps: RelinkDeps,
  userId: string,
  url: string,
  voiceId: string | undefined,
): Promise<{ contact: AgentRecord; moved: boolean } | undefined> {
  const { stores, hub, now } = deps;
  const endpoint = parseConnectorEndpoint(url);
  if (endpoint === undefined) return undefined;
  const computer = await stores.connectors.get(userId, endpoint.connectorId);
  if (computer === undefined) return undefined;
  const contacts = await stores.agents.list(userId);
  // Already a contact for exactly this agent on this computer (a second add, or one racing
  // this move): that contact, not a duplicate.
  const existing = contacts.find((a) => a.protocol === 'cord-connector' && a.endpoint_url === url);
  if (existing !== undefined) return { contact: existing, moved: false };
  const candidates: AgentRecord[] = [];
  for (const agent of contacts) {
    if (agent.protocol !== 'cord-connector') continue;
    const old = parseConnectorEndpoint(agent.endpoint_url);
    if (old === undefined || old.localAgent !== endpoint.localAgent) continue;
    if (old.connectorId === endpoint.connectorId) continue;
    const gone = computerGone({
      oldComputer: await stores.connectors.get(userId, old.connectorId),
      contactComputerName: agent.computer_name,
      newName: computer.name,
      online: hub?.isOnline(userId, old.connectorId) ?? false,
      droppedAt: hub?.droppedAt(old.connectorId),
      now: now().getTime(),
    });
    if (gone) candidates.push(agent);
  }
  if (candidates.length !== 1) return undefined;
  const contact = candidates[0]!;
  // The voice just chosen applies; the name the owner set stays. A new computer: untested.
  const moved = await stores.agents.update(
    userId,
    contact.id,
    {
      endpoint_url: url,
      computer_name: null,
      status: 'untested',
      ...(voiceId !== undefined && { voice_id: voiceId }),
      ifRevision: revisionOf(contact),
    },
    now(),
  );
  if (moved === undefined) {
    // Two adds at once: the other one moved it. Same contact, never a duplicate.
    const current = await stores.agents.get(userId, contact.id);
    return current?.endpoint_url === url ? { contact: current, moved: true } : undefined;
  }
  deps.log.info(
    { event: 'contact_relinked', agent_id: moved.id },
    'contact moved to a re-linked computer',
  );
  return { contact: moved, moved: true };
}
