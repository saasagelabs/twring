import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { CredentialKeys } from '@twring/config/gateway';
import {
  agentEndpointUrlSchema,
  agentIdSchema,
  agentProtocolSchema,
  agentStatusSchema,
  callHistoryItemSchema,
  connectionTestSummarySchema,
  mcpClientKindSchema,
  sessionScopeSchema,
  voiceIdSchema,
  type CallHistoryItem,
} from '@twring/contracts';
import { z } from 'zod';

import { rollupUsage, type UsageRollup } from '../calls/usage';
import {
  CollectionConnectorRepository,
  connectorRecordSchema,
  type ConnectorRepository,
} from '../connectors/store';

import { CredentialCipher, credentialAad, sealedSecretSchema } from './cipher';
import { JsonFileCollection, MemoryCollection, type Collection } from './collection';
import {
  EncryptedSpeechKeyVault,
  speechKeyRecordSchema,
  speechSettingsRecordSchema,
  type SpeechKeyVault,
} from './speech-keys';

/**
 * Storage rows (DATA_MODEL §3–5). Provider-neutral: every row carries `user_id` and every query is
 * scoped by it, so the Supabase repositories can replace these without touching the routes.
 */
export const agentRecordSchema = z.object({
  id: agentIdSchema,
  user_id: z.string().min(1),
  name: z.string(),
  name_set_by_owner: z.literal(true).optional(),
  mcp_client: mcpClientKindSchema.optional(),
  last_used_at: z.iso.datetime().optional(),
  last_replies_checked_at: z.iso.datetime().optional(),
  protocol: agentProtocolSchema,
  endpoint_url: agentEndpointUrlSchema,
  model: z.string().trim().min(1).max(200).optional(),
  session_key: z
    .string()
    .regex(/^twring-[0-9a-f]+$/)
    .optional(),
  voice_id: voiceIdSchema,
  /** Words to recognise; absent on rows written before keyterms existed. */
  keyterms: z.array(z.string()).optional(),
  status: agentStatusSchema,
  avatar_version: z.number().int().min(1).optional(),
  /** Kept after photo removal so a later upload cannot reuse the old cache key. */
  avatar_version_last: z.number().int().min(1).optional(),
  last_test: connectionTestSummarySchema.optional(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  /** Bumped on every update; absent (0) on rows written before revisions existed. */
  revision: z.number().int().min(0).optional(),
  /** Internal request consumed by the next connector channel; never returned by the API. */
  fresh_session_pending: z.literal(true).optional(),
  /**
   * Self-hosted shared agents: the same request for other people's own sessions, by their
   * session scope. Internal; never returned by the API.
   */
  fresh_session_scopes: z.array(sessionScopeSchema).max(500).optional(),
  /**
   * Self-hosted shared agents: words an agent learned in a team member's own session, heard on
   * that person's calls only (the owner's list stays the owner's). Internal.
   */
  person_keyterms: z
    .array(z.object({ person_id: z.string().min(1), words: z.array(z.string()) }))
    .max(500)
    .optional(),
  /**
   * The name of its computer, kept when that computer is removed, so the same computer linked
   * again finds this contact (wave 1, track 2.3). Internal; never returned by the API.
   */
  computer_name: z.string().max(200).optional(),
});
export type AgentRecord = z.infer<typeof agentRecordSchema>;

export type AgentPatch = Partial<
  Pick<
    AgentRecord,
    | 'name'
    | 'name_set_by_owner'
    | 'mcp_client'
    | 'last_used_at'
    | 'last_replies_checked_at'
    | 'protocol'
    | 'endpoint_url'
    | 'voice_id'
    | 'keyterms'
    | 'person_keyterms'
    | 'status'
    | 'last_test'
  >
> & {
  avatar_version?: number | null;
  avatar_version_last?: number;
  model?: string | null;
  computer_name?: string | null;
};

/**
 * A patch for `AgentRepository.update`. With `ifRevision`, it applies only while the stored
 * revision still equals it (compare-and-set under the collection lock).
 */
export type AgentUpdate = AgentPatch & { ifRevision?: number };

/** The record's revision; rows from before revisions existed count as 0. */
export function revisionOf(record: AgentRecord): number {
  return record.revision ?? 0;
}

export interface AgentRepository {
  /** Newest first. */
  list(userId: string): Promise<AgentRecord[]>;
  get(userId: string, agentId: string): Promise<AgentRecord | undefined>;
  /**
   * Atomically take a pending session reset for this owner and agent; with `scope`, the one for
   * that person's own session on a shared agent (the owner's own flag is untouched).
   */
  consumeFreshSession(userId: string, agentId: string, scope?: string): Promise<boolean>;
  requestFreshSession(userId: string, agentId: string, scope?: string): Promise<boolean>;
  ensureSessionKey(userId: string, agentId: string, replace?: boolean): Promise<string | undefined>;
  create(record: AgentRecord): Promise<AgentRecord>;
  /**
   * Undefined when the agent does not exist for this user, or when `ifRevision` is given and no
   * longer matches. Every applied update bumps `revision`.
   */
  update(
    userId: string,
    agentId: string,
    patch: AgentUpdate,
    now: Date,
  ): Promise<AgentRecord | undefined>;
  /** True when something was deleted. */
  delete(userId: string, agentId: string): Promise<boolean>;
  /** Deletes every agent of this user; resolves how many there were. */
  deleteAllForUser(userId: string): Promise<number>;
}

/** Holds each agent's secret encrypted; plaintext exists only in the gateway process, per use. */
export interface CredentialVault {
  put(userId: string, agentId: string, secret: string): Promise<void>;
  /** Throws `CredentialDecryptError` when the stored secret cannot be decrypted. */
  get(userId: string, agentId: string): Promise<string | undefined>;
  has(userId: string, agentId: string): Promise<boolean>;
  delete(userId: string, agentId: string): Promise<void>;
  /** Deletes every sealed secret of this user; resolves how many there were. */
  deleteAllForUser(userId: string): Promise<number>;
}

export interface CallHistoryRepository {
  record(userId: string, item: CallHistoryItem): Promise<void>;
  /** Newest first. */
  list(userId: string, limit: number): Promise<CallHistoryItem[]>;
  /**
   * Usage summed per UTC day and agent, oldest first, over the calls still kept (at most
   * MAX_HISTORY_PER_USER); `sinceDay` (`YYYY-MM-DD`) drops earlier days. For later dashboards.
   */
  usageRollup(userId: string, sinceDay?: string): Promise<UsageRollup[]>;
  /** Deletes this user's whole call history; resolves how many calls it held. */
  deleteAllForUser(userId: string): Promise<number>;
}

/** Removes every row owned by `userId` under the collection lock; resolves how many. */
function deleteOwnedRows<T extends { user_id: string }>(
  rows: Collection<T>,
  userId: string,
): Promise<number> {
  return rows.update((items) => {
    const kept = items.filter((row) => row.user_id !== userId);
    return { items: kept, result: items.length - kept.length };
  });
}

export class CollectionAgentRepository implements AgentRepository {
  constructor(private readonly rows: Collection<AgentRecord>) {}

  async list(userId: string): Promise<AgentRecord[]> {
    return (await this.rows.read())
      .filter((row) => row.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async get(userId: string, agentId: string): Promise<AgentRecord | undefined> {
    return (await this.rows.read()).find((row) => row.user_id === userId && row.id === agentId);
  }

  ensureSessionKey(userId: string, agentId: string, replace = false): Promise<string | undefined> {
    return this.rows.update((items) => {
      let key: string | undefined;
      const next = items.map((row) => {
        if (row.user_id !== userId || row.id !== agentId) return row;
        key = !replace ? row.session_key : undefined;
        if (key !== undefined) return row;
        key = `twring-${randomBytes(16).toString('hex')}`;
        return { ...row, session_key: key };
      });
      return { items: next, result: key };
    });
  }

  async consumeFreshSession(userId: string, agentId: string, scope?: string): Promise<boolean> {
    // Runs on every connector call and chat turn: read first, so the file is rewritten only when
    // a reset is actually pending. The update below re-checks under the lock.
    const row = (await this.rows.read()).find((r) => r.user_id === userId && r.id === agentId);
    if (scope !== undefined) {
      if (row?.fresh_session_scopes?.includes(scope) !== true) return false;
      return this.rows.update((items) => {
        let consumed = false;
        const next = items.map((r) => {
          if (r.user_id !== userId || r.id !== agentId) return r;
          const scopes = r.fresh_session_scopes ?? [];
          if (!scopes.includes(scope)) return r;
          consumed = true;
          const left = scopes.filter((s) => s !== scope);
          const updated: AgentRecord = { ...r, fresh_session_scopes: left };
          if (left.length === 0) delete updated.fresh_session_scopes;
          return updated;
        });
        return { items: consumed ? next : items, result: consumed };
      });
    }
    if (row?.fresh_session_pending !== true) return false;
    return this.rows.update((items) => {
      let consumed = false;
      const next = items.map((row) => {
        if (row.user_id !== userId || row.id !== agentId || !row.fresh_session_pending) return row;
        consumed = true;
        const updated = { ...row };
        delete updated.fresh_session_pending;
        return updated;
      });
      return { items: consumed ? next : items, result: consumed };
    });
  }

  requestFreshSession(userId: string, agentId: string, scope?: string): Promise<boolean> {
    return this.rows.update((items) => {
      let found = false;
      const next = items.map((row) => {
        if (row.user_id !== userId || row.id !== agentId) return row;
        found = true;
        if (scope === undefined) return { ...row, fresh_session_pending: true as const };
        const scopes = (row.fresh_session_scopes ?? []).filter((s) => s !== scope);
        // Bounded: the oldest pending request goes first.
        return { ...row, fresh_session_scopes: [...scopes, scope].slice(-500) };
      });
      return { items: found ? next : items, result: found };
    });
  }

  create(record: AgentRecord): Promise<AgentRecord> {
    return this.rows.update((items) => ({ items: [...items, record], result: record }));
  }

  update(
    userId: string,
    agentId: string,
    { ifRevision, ...patch }: AgentUpdate,
    now: Date,
  ): Promise<AgentRecord | undefined> {
    return this.rows.update((items) => {
      let updated: AgentRecord | undefined;
      const next = items.map((row) => {
        if (row.user_id !== userId || row.id !== agentId) return row;
        if (ifRevision !== undefined && revisionOf(row) !== ifRevision) return row;
        const nextRow = {
          ...row,
          ...patch,
          updated_at: now.toISOString(),
          revision: revisionOf(row) + 1,
        };
        if (patch.avatar_version === null) delete nextRow.avatar_version;
        if (patch.model === null) delete nextRow.model;
        if (patch.computer_name === null) delete nextRow.computer_name;
        if (patch.status === 'untested') delete nextRow.last_test;
        updated = agentRecordSchema.parse(nextRow);
        return updated;
      });
      return { items: updated === undefined ? items : next, result: updated };
    });
  }

  delete(userId: string, agentId: string): Promise<boolean> {
    return this.rows.update((items) => {
      const next = items.filter((row) => row.user_id !== userId || row.id !== agentId);
      return { items: next, result: next.length !== items.length };
    });
  }

  deleteAllForUser(userId: string): Promise<number> {
    return deleteOwnedRows(this.rows, userId);
  }
}

const credentialRecordSchema = z.object({
  user_id: z.string().min(1),
  agent_id: agentIdSchema,
  sealed: sealedSecretSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
type CredentialRecord = z.infer<typeof credentialRecordSchema>;

export class EncryptedCredentialVault implements CredentialVault {
  constructor(
    private readonly rows: Collection<CredentialRecord>,
    private readonly cipher: CredentialCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  put(userId: string, agentId: string, secret: string): Promise<void> {
    const sealed = this.cipher.seal(secret, credentialAad(userId, agentId));
    const stamp = this.now().toISOString();
    return this.rows.update((items) => {
      const existing = items.find((row) => row.user_id === userId && row.agent_id === agentId);
      const others = items.filter((row) => row !== existing);
      const record: CredentialRecord = {
        user_id: userId,
        agent_id: agentId,
        sealed,
        created_at: existing?.created_at ?? stamp,
        updated_at: stamp,
      };
      return { items: [...others, record], result: undefined };
    });
  }

  async get(userId: string, agentId: string): Promise<string | undefined> {
    const row = await this.find(userId, agentId);
    return row && this.cipher.open(row.sealed, credentialAad(userId, agentId));
  }

  async has(userId: string, agentId: string): Promise<boolean> {
    return (await this.find(userId, agentId)) !== undefined;
  }

  delete(userId: string, agentId: string): Promise<void> {
    return this.rows.update((items) => ({
      items: items.filter((row) => row.user_id !== userId || row.agent_id !== agentId),
      result: undefined,
    }));
  }

  deleteAllForUser(userId: string): Promise<number> {
    return deleteOwnedRows(this.rows, userId);
  }

  private async find(userId: string, agentId: string): Promise<CredentialRecord | undefined> {
    return (await this.rows.read()).find(
      (row) => row.user_id === userId && row.agent_id === agentId,
    );
  }
}

export const historyRecordSchema = callHistoryItemSchema.extend({ user_id: z.string().min(1) });
type HistoryRecord = z.infer<typeof historyRecordSchema>;

/** Older entries beyond this per user are dropped: the app shows only recent calls. */
export const MAX_HISTORY_PER_USER = 200;

export class CollectionCallHistoryRepository implements CallHistoryRepository {
  constructor(private readonly rows: Collection<HistoryRecord>) {}

  record(userId: string, item: CallHistoryItem): Promise<void> {
    return this.rows.update((items) => {
      const mine = items.filter((row) => row.user_id === userId);
      const drop = new Set(
        mine
          .sort((a, b) => b.started_at.localeCompare(a.started_at))
          .slice(MAX_HISTORY_PER_USER - 1),
      );
      const kept = items.filter((row) => !drop.has(row));
      return { items: [...kept, { ...item, user_id: userId }], result: undefined };
    });
  }

  async list(userId: string, limit: number): Promise<CallHistoryItem[]> {
    return (await this.rows.read())
      .filter((row) => row.user_id === userId)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, limit)
      .map(({ user_id: _userId, ...item }) => item);
  }

  async usageRollup(userId: string, sinceDay?: string): Promise<UsageRollup[]> {
    const mine = (await this.rows.read())
      .filter((row) => row.user_id === userId)
      .filter((row) => sinceDay === undefined || row.started_at.slice(0, 10) >= sinceDay)
      .map(({ user_id: _userId, ...item }) => item);
    return rollupUsage(mine);
  }

  deleteAllForUser(userId: string): Promise<number> {
    return deleteOwnedRows(this.rows, userId);
  }
}

export interface Stores {
  agents: AgentRepository;
  credentials: CredentialVault;
  history: CallHistoryRepository;
  /** Paired computers (ADR-023). */
  connectors: ConnectorRepository;
  /** Each person's own Deepgram and Cartesia keys, sealed. */
  speechKeys: SpeechKeyVault;
}

/** The V1 store: one JSON file per collection under `dataDir` (ADR-018). */
export function createFileStores(dataDir: string, keys: CredentialKeys): Stores {
  return {
    agents: new CollectionAgentRepository(
      new JsonFileCollection(join(dataDir, 'agents.json'), agentRecordSchema),
    ),
    credentials: new EncryptedCredentialVault(
      new JsonFileCollection(join(dataDir, 'credentials.json'), credentialRecordSchema),
      new CredentialCipher(keys),
    ),
    history: new CollectionCallHistoryRepository(
      new JsonFileCollection(join(dataDir, 'call-history.json'), historyRecordSchema),
    ),
    connectors: new CollectionConnectorRepository(
      new JsonFileCollection(join(dataDir, 'connectors.json'), connectorRecordSchema),
    ),
    speechKeys: new EncryptedSpeechKeyVault(
      new JsonFileCollection(join(dataDir, 'speech-keys.json'), speechKeyRecordSchema),
      new CredentialCipher(keys),
      () => new Date(),
      new JsonFileCollection(join(dataDir, 'speech-settings.json'), speechSettingsRecordSchema),
    ),
  };
}

/** In-memory stores for tests. */
export function createMemoryStores(keys: CredentialKeys): Stores {
  return {
    agents: new CollectionAgentRepository(new MemoryCollection()),
    credentials: new EncryptedCredentialVault(new MemoryCollection(), new CredentialCipher(keys)),
    history: new CollectionCallHistoryRepository(new MemoryCollection()),
    connectors: new CollectionConnectorRepository(new MemoryCollection()),
    speechKeys: new EncryptedSpeechKeyVault(new MemoryCollection(), new CredentialCipher(keys)),
  };
}
