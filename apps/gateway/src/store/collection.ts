import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { z } from 'zod';

/**
 * A small list of records with serialized read-modify-write. The V1 store (ADR-018) keeps each
 * collection in one JSON file; tests use the in-memory one. Repositories sit on top of this, so
 * swapping to Postgres replaces the repositories, not their callers.
 */
export interface Collection<T> {
  read(): Promise<readonly T[]>;
  /** Runs `change` on the current items under the collection's lock and saves what it returns. */
  update<R>(change: (items: readonly T[]) => { items: readonly T[]; result: R }): Promise<R>;
}

/** Serializes async work: each task starts after the previous one settles. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<R>(task: () => Promise<R>): Promise<R> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class MemoryCollection<T> implements Collection<T> {
  private items: readonly T[] = [];
  private readonly lock = new Mutex();

  read(): Promise<readonly T[]> {
    return Promise.resolve(this.items);
  }

  update<R>(change: (items: readonly T[]) => { items: readonly T[]; result: R }): Promise<R> {
    return this.lock.run(() => {
      const { items, result } = change(this.items);
      this.items = items;
      return Promise.resolve(result);
    });
  }
}

/** Thrown when a data file exists but is not what Twring wrote. Never carries the file contents. */
export class StoreCorruptError extends Error {
  constructor(readonly file: string) {
    super(`data file is unreadable: ${file}`);
    this.name = 'StoreCorruptError';
  }
}

/**
 * One JSON file per collection. Writes go to a temp file in the same folder and are renamed over
 * the old file, so a crash leaves either the old or the new contents, never half of each. The lock
 * is per process, which matches the single-process gateway (ADR-018).
 */
export class JsonFileCollection<T> implements Collection<T> {
  /**
   * Told when a load skipped rows that no longer match the schema (main.ts logs it). The rows
   * themselves go to `<file>.rejected`; the hook gets only the file and the count.
   */
  static onRowsSkipped: ((file: string, count: number) => void) | undefined;

  private readonly lock = new Mutex();
  private cache: readonly T[] | undefined;

  constructor(
    private readonly file: string,
    private readonly schema: z.ZodType<T>,
    private readonly options: { onRowsSkipped?: (file: string, count: number) => void } = {},
  ) {}

  read(): Promise<readonly T[]> {
    return this.lock.run(() => this.load());
  }

  update<R>(change: (items: readonly T[]) => { items: readonly T[]; result: R }): Promise<R> {
    return this.lock.run(async () => {
      const { items, result } = change(await this.load());
      await this.save(items);
      this.cache = items;
      return result;
    });
  }

  private async load(): Promise<readonly T[]> {
    if (this.cache !== undefined) return this.cache;
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.cache = []);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StoreCorruptError(this.file);
    }
    if (!Array.isArray(parsed)) throw new StoreCorruptError(this.file);
    const rows: unknown[] = parsed;
    const results = rows.map((row) => this.schema.safeParse(row));
    const good = results.filter((result) => result.success).map((result) => result.data);
    const bad = rows.filter((_row, index) => !results[index]!.success);
    // No readable row at all is a schema mismatch or a foreign file, not one bad row: fail closed
    // rather than save an empty list over it.
    if (rows.length > 0 && good.length === 0) throw new StoreCorruptError(this.file);
    if (bad.length > 0) {
      // One bad row must not lock every user out (review finding 3): keep it aside, load the rest.
      await appendFile(
        `${this.file}.rejected`,
        bad
          .map(
            (row) => `${JSON.stringify(row)}
`,
          )
          .join(''),
        { mode: 0o600 },
      );
      (this.options.onRowsSkipped ?? JsonFileCollection.onRowsSkipped)?.(this.file, bad.length);
    }
    return (this.cache = good);
  }

  private async save(items: readonly T[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const handle = await open(temp, 'w', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(items, null, 2)}\n`, 'utf8');
        // Flush to disk before the rename, so a power loss cannot leave a renamed empty file.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
