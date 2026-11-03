import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import type { CredentialKeys } from '@twring/config/gateway';
import { parseConnectorEndpoint, SCOPED_SESSIONS_FEATURE } from '@twring/contracts';

import type { AgentFactory } from '../calls/agents';
import type { ConnectorHub } from '../connectors/hub';
import type { PeopleRepository } from '../selfhost/people';
import type { AgentRecord, AgentRepository, Stores } from '../store/repositories';

import { savedAgentFactory, type EndpointPolicy } from './service';

/**
 * Server agents on a self-hosted server (self-host ruling): agents on a computer linked with
 * `shared: true` by an admin. The person who linked them owns them; everyone in the same space
 * may see and call them; only the owner edits or removes them. Calls and chats stay per person:
 * everyone but the owner talks to the agent in their own session on that computer, named by an
 * opaque `session_scope`. Hosted Twring never builds any of this, so nothing there is ever shared.
 */

/** Who shares a space with whom. */
export interface AgentSpace {
  /** Everyone else still on the server in this person's space; empty for an unknown or removed person. */
  peersOf(personId: string): Promise<string[]>;
  /** True for an admin still on the server. */
  isAdmin(personId: string): Promise<boolean>;
}

/** The space as self-hosted people define it. */
export function peopleSpace(people: Pick<PeopleRepository, 'get' | 'list'>): AgentSpace {
  return {
    async peersOf(personId) {
      const person = await people.get(personId);
      if (person === undefined || person.removed_at !== undefined) return [];
      return (await people.list(person.space_id)).map((p) => p.id).filter((id) => id !== personId);
    },
    async isAdmin(personId) {
      const person = await people.get(personId);
      return person !== undefined && person.removed_at === undefined && person.role === 'admin';
    },
  };
}

/**
 * The key session scopes are made with: the current credentials key (`CORD_CREDENTIALS_KEY`) run
 * through HKDF-SHA256 with info `twring-session-scope-v1`, never the key itself. Rotating that key
 * starts everyone but the owners on new agent sessions.
 */
export function sessionScopeKey(keys: CredentialKeys): Buffer {
  const key = keys.keys.get(keys.currentVersion);
  if (key === undefined) throw new Error('current credentials key is missing');
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(key, 'base64'), Buffer.alloc(0), 'twring-session-scope-v1', 32),
  );
}

/** A person's scope: HMAC-SHA256(key, person id), the first 16 bytes in hex. Opaque to computers. */
export function sessionScope(key: Buffer, personId: string): string {
  return createHmac('sha256', key).update(personId, 'utf8').digest('hex').slice(0, 32);
}

/** An agent as one person sees it. */
export interface AgentAccess {
  record: AgentRecord;
  /** Its computer was linked as shared. */
  shared: boolean;
  /** Its owner is in the same space as the person asking. */
  sameSpace: boolean;
}

/** The owner, or anyone in the owner's space when the agent is shared. */
export function canUseAgent(personId: string, agent: AgentAccess): boolean {
  return agent.record.user_id === personId || (agent.shared && agent.sameSpace);
}

/** Only the owner edits, tests or removes an agent. */
export function canEditAgent(personId: string, agent: AgentAccess): boolean {
  return agent.record.user_id === personId;
}

/** Someone other than the owner talking to a shared agent: whose session it is. */
export interface AgentCaller {
  personId: string;
  scope: string;
}

export class SharedAgents {
  constructor(
    private readonly stores: Pick<Stores, 'agents' | 'connectors'>,
    private readonly space: AgentSpace,
    private readonly scopeKey: Buffer,
    private readonly hub?: Pick<ConnectorHub, 'supports'>,
  ) {}

  isAdmin(personId: string): Promise<boolean> {
    return this.space.isAdmin(personId);
  }

  /**
   * True when the agent's computer is still linked and was linked as shared. A removed owner's
   * computers are revoked (their rows deleted), so their agents stop being shared at once.
   */
  async isShared(record: AgentRecord): Promise<boolean> {
    if (record.protocol !== 'cord-connector') return false;
    const endpoint = parseConnectorEndpoint(record.endpoint_url);
    if (endpoint === undefined) return false;
    const computer = await this.stores.connectors.get(record.user_id, endpoint.connectorId);
    return computer?.shared === true;
  }

  /** Other people's shared agents this person may see and call, newest first. */
  async listFor(personId: string): Promise<AgentRecord[]> {
    const found: AgentRecord[] = [];
    for (const peer of await this.space.peersOf(personId)) {
      for (const record of await this.stores.agents.list(peer)) {
        const access = { record, shared: await this.isShared(record), sameSpace: true };
        if (canUseAgent(personId, access)) found.push(record);
      }
    }
    return found.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /** Another person's shared agent this person may use; undefined otherwise. */
  async find(personId: string, agentId: string): Promise<AgentRecord | undefined> {
    for (const peer of await this.space.peersOf(personId)) {
      const record = await this.stores.agents.get(peer, agentId);
      if (record === undefined) continue;
      const access = { record, shared: await this.isShared(record), sameSpace: true };
      return canUseAgent(personId, access) ? record : undefined;
    }
    return undefined;
  }

  scopeFor(personId: string): string {
    return sessionScope(this.scopeKey, personId);
  }

  /** Whose session a call or chat to `record` by `personId` uses; undefined for the owner. */
  callerFor(personId: string, record: AgentRecord): AgentCaller | undefined {
    return record.user_id === personId ? undefined : { personId, scope: this.scopeFor(personId) };
  }

  /**
   * The person a computer's `session_scope` stands for: someone in the owner's space, never the
   * owner. Undefined for a scope that matches nobody (forged, or the person left).
   */
  async personForScope(ownerId: string, scope: string): Promise<string | undefined> {
    const wanted = Buffer.from(scope, 'utf8');
    for (const peer of await this.space.peersOf(ownerId)) {
      const candidate = Buffer.from(this.scopeFor(peer), 'utf8');
      if (candidate.length === wanted.length && timingSafeEqual(candidate, wanted)) return peer;
    }
    return undefined;
  }

  /**
   * True when `personId` (not the owner) would talk to a shared agent whose computer is connected
   * but cannot keep a session per person. They are refused rather than given the owner's session.
   */
  linkOutdated(personId: string, record: AgentRecord): boolean {
    if (record.user_id === personId || record.protocol !== 'cord-connector') return false;
    const endpoint = parseConnectorEndpoint(record.endpoint_url);
    if (endpoint === undefined || this.hub === undefined) return false;
    return this.hub.supports(endpoint.connectorId, SCOPED_SESSIONS_FEATURE) === false;
  }
}

/** The agents a person may open a chat or file with: their own, or (self-hosted) shared ones. */
export function visibleAgents(
  agents: Pick<AgentRepository, 'get'>,
  shared: SharedAgents | undefined,
): Pick<AgentRepository, 'get'> {
  if (shared === undefined) return agents;
  return {
    get: async (userId, agentId) =>
      (await agents.get(userId, agentId)) ?? (await shared.find(userId, agentId)),
  };
}

/**
 * How chats reach saved agents: the agent and its computer are the owner's; someone else on a
 * shared agent talks in their own session. Without `shared` (hosted) this is exactly the owner's
 * own agent, as before.
 */
export function threadAgentAccess(
  stores: Stores,
  policy: EndpointPolicy,
  hub: Pick<ConnectorHub, 'agentStatus' | 'supports'>,
  shared: SharedAgents | undefined,
): {
  agents: Pick<AgentRepository, 'get'>;
  agentFactory(userId: string, record: AgentRecord): AgentFactory;
  agentStatus(userId: string, record: AgentRecord): 'online' | 'offline' | 'agent_missing';
} {
  return {
    agents: visibleAgents(stores.agents, shared),
    agentFactory: (userId, record) => {
      const caller = shared?.callerFor(userId, record);
      return savedAgentFactory(record.user_id, record, stores, policy, undefined, caller);
    },
    agentStatus: (userId, record) => {
      if (record.protocol !== 'cord-connector') return 'online';
      const endpoint = parseConnectorEndpoint(record.endpoint_url);
      if (endpoint === undefined) return 'offline';
      // Never the owner's session for someone else: an outdated computer counts as offline.
      if (shared?.linkOutdated(userId, record) === true) return 'offline';
      return hub.agentStatus(record.user_id, endpoint.connectorId, endpoint.localAgent);
    },
  };
}
