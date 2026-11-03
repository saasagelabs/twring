/**
 * In-process record of Delete my data runs, shared by the routes that delete a person's data and
 * the routes that save it after a slow check (a speech key). A save that started before, or
 * finishes during, a deletion is dropped instead of re-adding what was just removed.
 */
export class UserDeletions {
  private readonly running = new Map<string, number>();
  private readonly epochs = new Map<string, number>();

  /** Marks a deletion as running; call `end` when its sweeps are done. */
  begin(userId: string): void {
    this.running.set(userId, (this.running.get(userId) ?? 0) + 1);
    this.epochs.set(userId, this.epoch(userId) + 1);
  }

  end(userId: string): void {
    const left = (this.running.get(userId) ?? 1) - 1;
    if (left > 0) this.running.set(userId, left);
    else this.running.delete(userId);
  }

  /** How many deletions have started for this person; compare before and after a slow step. */
  epoch(userId: string): number {
    return this.epochs.get(userId) ?? 0;
  }

  /** True while a deletion runs, or when one started since `epoch` was read. */
  interrupted(userId: string, since: number): boolean {
    return this.running.has(userId) || this.epoch(userId) !== since;
  }
}
