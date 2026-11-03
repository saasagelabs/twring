import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { fileIdSchema } from '@twring/contracts';

const STAGED_NAME = /^fil_[a-z2-7]{20}\.[0-9a-f]{16}\.tmp$/;

export class FileBlobStore {
  constructor(private readonly dir: string) {}

  private path(id: string): string {
    fileIdSchema.parse(id);
    return join(this.dir, id);
  }

  async write(fileId: string, sealed: Buffer): Promise<void> {
    const staged = await this.stage(fileId, sealed);
    try {
      await staged.commit();
    } catch (error) {
      await staged.discard();
      throw error;
    }
  }

  async stage(
    fileId: string,
    sealed: Buffer,
  ): Promise<{ commit(): Promise<void>; discard(): Promise<void> }> {
    const target = this.path(fileId);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temp, sealed, { mode: 0o600, flag: 'wx' });
    return {
      commit: () => rename(temp, target),
      discard: async () => {
        await unlink(temp).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      },
    };
  }

  async read(fileId: string): Promise<Buffer> {
    return readFile(this.path(fileId));
  }

  async delete(fileId: string): Promise<void> {
    try {
      await unlink(this.path(fileId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async list(): Promise<{ id: string; mtime: Date }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const rows: { id: string; mtime: Date }[] = [];
    for (const id of names) {
      if (!fileIdSchema.safeParse(id).success) continue;
      try {
        rows.push({ id, mtime: (await stat(this.path(id))).mtime });
      } catch (error) {
        // Deleted between the listing and the stat.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return rows;
  }

  /** Temp files left by an upload that crashed between staging and renaming. */
  async listStaged(): Promise<{ name: string; mtime: Date }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const rows: { name: string; mtime: Date }[] = [];
    for (const name of names) {
      if (!STAGED_NAME.test(name)) continue;
      try {
        rows.push({ name, mtime: (await stat(join(this.dir, name))).mtime });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return rows;
  }

  async deleteStaged(name: string): Promise<void> {
    if (!STAGED_NAME.test(name)) throw new Error('not a staged file name');
    await unlink(join(this.dir, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
