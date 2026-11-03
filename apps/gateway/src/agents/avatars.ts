import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { agentIdSchema } from '@twring/contracts';
import type { CredentialKeys } from '@twring/config/gateway';

import { fileKeys, openBlob, sealBlob } from '../files/cipher';

/** Encrypted JPEGs, scoped to their owner and agent in both the path and AEAD data. */
export class AvatarStore {
  private readonly keys: CredentialKeys;

  constructor(
    private readonly dataDir: string,
    keys: CredentialKeys,
  ) {
    this.keys = fileKeys(keys);
  }

  private path(userId: string, agentId: string): string {
    agentIdSchema.parse(agentId);
    // User IDs are opaque, but must never influence the directory tree.
    if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('invalid user id');
    return join(this.dataDir, 'avatars', userId, `${agentId}.bin`);
  }

  private aad(userId: string, agentId: string): string {
    return `avatar:${userId}:${agentId}`;
  }

  async put(userId: string, agentId: string, bytes: Buffer): Promise<void> {
    const path = this.path(userId, agentId);
    await mkdir(join(this.dataDir, 'avatars', userId), { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      sealBlob(this.keys, this.keys.currentVersion, bytes, this.aad(userId, agentId)),
      { mode: 0o600 },
    );
  }

  async get(userId: string, agentId: string): Promise<Buffer | undefined> {
    try {
      return openBlob(
        this.keys,
        await readFile(this.path(userId, agentId)),
        this.aad(userId, agentId),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async delete(userId: string, agentId: string): Promise<void> {
    await unlink(this.path(userId, agentId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async deleteAllForUser(userId: string): Promise<void> {
    // Validate before recursive removal.
    const directory = this.path(userId, 'agt_aaaaaaaaaaaaaaaaaaaa');
    await rm(join(directory, '..'), { recursive: true, force: true });
  }
}
