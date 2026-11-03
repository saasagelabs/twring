import {
  connectorIdSchema,
  localAgentSchema,
  sessionRefSchema,
  sessionScopeSchema,
} from '@twring/contracts';
import { z } from 'zod';

import type { Collection } from '../store/collection';

const MAX_SCOPED_REFS = 500;

/**
 * A paired computer (ADR-023). Only the SHA-256 of its token is stored: a leaked data file cannot
 * be replayed as a connector. Rows are scoped by `user_id` like every other row.
 */
export const connectorRecordSchema = z.object({
  id: connectorIdSchema,
  user_id: z.string().min(1),
  name: z.string(),
  token_hash: z.string().regex(/^[0-9a-f]{64}$/),
  agents: z.array(localAgentSchema),
  created_at: z.iso.datetime(),
  last_seen_at: z.iso.datetime().optional(),
  /** Self-hosted only: linked by an admin as shared, so its agents are server agents. */
  shared: z.literal(true).optional(),
  /**
   * Shared computers: agent sessions known to belong to a team member's scope (learned from their
   * scoped results and rings), newest last. An unscoped ring or result naming one is refused, so
   * the owner never resumes a member's session.
   */
  scoped_refs: z
    .array(z.object({ ref: sessionRefSchema, scope: sessionScopeSchema }))
    .max(MAX_SCOPED_REFS)
    .optional(),
});
export type ConnectorRecord = z.infer<typeof connectorRecordSchema>;

export interface ConnectorRepository {
  /** Newest first. */
  list(userId: string): Promise<ConnectorRecord[]>;
  get(userId: string, connectorId: string): Promise<ConnectorRecord | undefined>;
  /** The connector a token hash belongs to, across all users (socket authentication). */
  findByTokenHash(tokenHash: string): Promise<ConnectorRecord | undefined>;
  create(record: ConnectorRecord): Promise<ConnectorRecord>;
  /**
   * Records a successful connect and the agents it now offers (and its name, on a re-link);
   * undefined when revoked.
   */
  touch(
    connectorId: string,
    agents: ConnectorRecord['agents'],
    now: Date,
    name?: string,
  ): Promise<ConnectorRecord | undefined>;
  delete(userId: string, connectorId: string): Promise<boolean>;
  /** Remembers that a session belongs to a team member's scope (bounded, oldest dropped). */
  noteScopedRef(connectorId: string, ref: string, scope: string): Promise<void>;
  /** Removes every connector of this user; resolves the removed ids. */
  deleteAllForUser(userId: string): Promise<string[]>;
}

export class CollectionConnectorRepository implements ConnectorRepository {
  constructor(private readonly rows: Collection<ConnectorRecord>) {}

  async list(userId: string): Promise<ConnectorRecord[]> {
    return (await this.rows.read())
      .filter((row) => row.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async get(userId: string, connectorId: string): Promise<ConnectorRecord | undefined> {
    return (await this.rows.read()).find((row) => row.user_id === userId && row.id === connectorId);
  }

  async findByTokenHash(tokenHash: string): Promise<ConnectorRecord | undefined> {
    return (await this.rows.read()).find((row) => row.token_hash === tokenHash);
  }

  create(record: ConnectorRecord): Promise<ConnectorRecord> {
    return this.rows.update((items) => ({ items: [...items, record], result: record }));
  }

  touch(
    connectorId: string,
    agents: ConnectorRecord['agents'],
    now: Date,
    name?: string,
  ): Promise<ConnectorRecord | undefined> {
    return this.rows.update((items) => {
      let updated: ConnectorRecord | undefined;
      const next = items.map((row) => {
        if (row.id !== connectorId) return row;
        updated = {
          ...row,
          agents,
          last_seen_at: now.toISOString(),
          ...(name !== undefined && { name }),
        };
        return updated;
      });
      return { items: updated === undefined ? items : next, result: updated };
    });
  }

  async noteScopedRef(connectorId: string, ref: string, scope: string): Promise<void> {
    const row = (await this.rows.read()).find((r) => r.id === connectorId);
    if (row?.scoped_refs?.some((s) => s.ref === ref && s.scope === scope) === true) return;
    await this.rows.update((items) => ({
      items: items.map((r) =>
        r.id !== connectorId
          ? r
          : {
              ...r,
              scoped_refs: [
                ...(r.scoped_refs ?? []).filter((s) => s.ref !== ref),
                { ref, scope },
              ].slice(-MAX_SCOPED_REFS),
            },
      ),
      result: undefined,
    }));
  }

  delete(userId: string, connectorId: string): Promise<boolean> {
    return this.rows.update((items) => {
      const next = items.filter((row) => row.user_id !== userId || row.id !== connectorId);
      return { items: next, result: next.length !== items.length };
    });
  }

  deleteAllForUser(userId: string): Promise<string[]> {
    return this.rows.update((items) => ({
      items: items.filter((row) => row.user_id !== userId),
      result: items.filter((row) => row.user_id === userId).map((row) => row.id),
    }));
  }
}
