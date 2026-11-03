import type { FastifyBaseLogger } from 'fastify';

import type { SelfhostStores } from './people';

export type RemovalOutcome = 'removed' | 'not_found' | 'last_admin' | 'unavailable';

/** What the rest of the server does when a person goes; app.ts attaches these. */
export interface RemovalHooks {
  /** Revokes the person's computers and ring push registrations. */
  revokeAccess?: (personId: string) => Promise<void>;
  /** The full Delete my data sequence (purge). */
  purge?: (personId: string, log: FastifyBaseLogger) => Promise<unknown>;
}

/**
 * Removes a person from a self-hosted server, from the app or from the admin listener: their
 * paired phones, computers and ring registrations stop working at once, and `purge` also deletes
 * everything they had, through the same steps as Delete my data.
 */
export class PersonRemover {
  private hooks: RemovalHooks = {};

  constructor(private readonly stores: SelfhostStores) {}

  attach(hooks: RemovalHooks): void {
    this.hooks = hooks;
  }

  async remove(
    personId: string,
    options: { purge: boolean; log: FastifyBaseLogger },
  ): Promise<RemovalOutcome> {
    const purge = this.hooks.purge;
    if (options.purge && purge === undefined) return 'unavailable';
    const person = await this.stores.people.get(personId);
    if (person === undefined) return 'not_found';
    if (person.removed_at === undefined) {
      const outcome = await this.stores.people.remove(personId);
      if (outcome !== 'removed') return outcome;
    } else if (!options.purge) {
      // Already removed: only a purge (first time, or a retry after a failure) has work left.
      return 'not_found';
    }
    // Every step below is safe to run again, so a purge that failed part-way can be retried.
    await this.stores.devices.removeAllFor(personId);
    await this.hooks.revokeAccess?.(personId);
    // Delete my data ends with the person and their phone records themselves.
    if (options.purge) await purge?.(personId, options.log);
    options.log.info({ event: 'person_removed', purged: options.purge }, 'person removed');
    return 'removed';
  }
}
