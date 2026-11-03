import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { FILE_LINK_TTL_MS, MAX_FILE_NAME_CHARS, type Attachment } from '@twring/contracts';
import type { CredentialKeys } from '@twring/config/gateway';

import type { FileBlobStore } from './blobs';
import { fileAad, fileKeys, fileLinkKey, openBlob, sealBlob } from './cipher';
import type { FileRow, SqliteThreadStore } from '../threads/store';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const newId = () => `fil_${[...randomBytes(20)].map((byte) => ALPHABET[byte & 31]).join('')}`;
const extension: Record<Attachment['mime_type'], string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
};

export function cleanFileName(raw: string, type: Attachment['mime_type']): string {
  let name =
    raw
      .split(/[\\/]/)
      .at(-1)!
      // eslint-disable-next-line no-control-regex -- file names must drop ASCII controls
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
      // Direction marks and overrides can disguise a name ("photo‮gpj.exe" shows as photo…).
      .replace(/[‎‏‪-‮⁦-⁩]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'file';
  const ext = extension[type];
  const hasExtension =
    name.toLowerCase().endsWith(ext) ||
    (type === 'image/jpeg' && name.toLowerCase().endsWith('.jpeg')) ||
    (type === 'text/markdown' && name.toLowerCase().endsWith('.markdown'));
  if (!hasExtension) name += ext;
  if (name.length > MAX_FILE_NAME_CHARS) {
    const suffix = name.slice(name.lastIndexOf('.'));
    name = name.slice(0, MAX_FILE_NAME_CHARS - suffix.length) + suffix;
  }
  return name;
}

export class FileService {
  private readonly keys: CredentialKeys;
  private readonly linkKey: Buffer;
  constructor(
    readonly store: SqliteThreadStore,
    readonly blobs: FileBlobStore,
    keys: CredentialKeys,
    private readonly publicUrl: string,
    private readonly log?: { warn(obj: Record<string, unknown>, message: string): void },
  ) {
    this.keys = fileKeys(keys);
    this.linkKey = fileLinkKey(keys);
  }

  async upload(input: {
    userId: string;
    agentId: string;
    clientId: string;
    name: string;
    mimeType: Attachment['mime_type'];
    bytes: Buffer;
    direction?: 'owner' | 'agent';
    width?: number;
    height?: number;
  }): Promise<{ file: FileRow; created: boolean }> {
    const id = newId();
    const sealed = sealBlob(
      this.keys,
      this.keys.currentVersion,
      input.bytes,
      fileAad(input.userId, id),
    );
    const staged = await this.blobs.stage(id, sealed);
    try {
      const result = this.store.insertFile({
        id,
        userId: input.userId,
        agentId: input.agentId,
        clientId: input.clientId,
        direction: input.direction ?? 'owner',
        name: cleanFileName(input.name, input.mimeType),
        mime_type: input.mimeType,
        size_bytes: input.bytes.length,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        ...(input.width && { width: input.width }),
        ...(input.height && { height: input.height }),
      });
      if (!result.created) {
        await staged.discard();
        return result;
      }
      try {
        await staged.commit();
      } catch (error) {
        this.store.deleteFiles([id]);
        throw error;
      }
      return result;
    } catch (error) {
      await staged.discard();
      throw error;
    }
  }

  async bytes(file: FileRow): Promise<Buffer> {
    return openBlob(this.keys, await this.blobs.read(file.id), fileAad(file.userId, file.id));
  }

  signedLink(fileId: string, now: Date = new Date()): string {
    const exp = Math.floor((now.getTime() + FILE_LINK_TTL_MS) / 1000);
    const sig = createHmac('sha256', this.linkKey).update(`${fileId}.${exp}`).digest('base64url');
    return `${this.publicUrl}/v1/files/${fileId}?exp=${exp}&sig=${sig}`;
  }

  verifyLink(fileId: string, exp: string, sig: string, now: Date = new Date()): boolean {
    if (!/^\d+$/.test(exp) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
    const expires = Number(exp) * 1000;
    if (
      !Number.isSafeInteger(expires) ||
      expires <= now.getTime() ||
      expires > now.getTime() + FILE_LINK_TTL_MS + 60_000
    )
      return false;
    const expected = createHmac('sha256', this.linkKey).update(`${fileId}.${exp}`).digest();
    const received = Buffer.from(sig, 'base64url');
    // Base64url's last character has spare bits, so several strings decode to the same bytes;
    // only the canonical encoding is a valid signature.
    return (
      received.length === expected.length &&
      received.toString('base64url') === sig &&
      timingSafeEqual(received, expected)
    );
  }

  async deleteBlobs(ids: string[]): Promise<void> {
    for (const id of ids)
      await this.blobs.delete(id).catch((error: unknown) =>
        this.log?.warn(
          {
            event: 'file_blob_delete_failed',
            file_id: id,
            error: error instanceof Error ? error.name : 'unknown',
          },
          'file_blob_delete_failed',
        ),
      );
  }

  async sweep(now: Date = new Date()): Promise<void> {
    const stale = [
      ...this.store.staleUnattachedFiles(new Date(now.getTime() - 24 * 60 * 60_000)),
      // Files of messages that were pruned from a full thread.
      ...this.store.danglingFiles(),
    ];
    this.store.deleteFiles(stale);
    await this.deleteBlobs(stale);
    for (const item of await this.blobs.listStaged())
      if (item.mtime.getTime() < now.getTime() - 60 * 60_000)
        await this.blobs.deleteStaged(item.name);
    for (const item of await this.blobs.list())
      if (item.mtime.getTime() < now.getTime() - 60 * 60_000 && !this.store.fileOwner(item.id))
        await this.deleteBlobs([item.id]);
  }
}
