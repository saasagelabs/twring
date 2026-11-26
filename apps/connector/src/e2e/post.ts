import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  base64urlDecode,
  base64urlEncode,
  CAN_SEAL_HEADER,
  errorResponseSchema,
  fileAad,
  MAX_FILE_BYTES,
  newFileKey,
  sealFile,
  type SealedEnvelopeV1,
  type SealedPayload,
} from '@twring/contracts';

import type { ConnectorConfig } from '../config';
import { mimeForName, UploadError, uploadFile } from '../upload';
import { cleanName } from '../turn-files';
import type { E2eConfig } from './keys';
import { ReplayWindow, sealOutgoing, type SealContext } from './sealed';
import { CHUNK_CHARS, splitText } from './turn';

export const UNPAIRED_LINE = 'This chat is private. Pair this computer again from your phone.';

export class PrivatePostError extends Error {
  constructor(
    readonly code: 'private_post_unpaired' | 'not_private' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'PrivatePostError';
  }
}

/** The header every plain post of this connector carries (see ADR-045). */
export const CAN_SEAL = { [CAN_SEAL_HEADER]: '1' } as const;

/** True when the gateway refused a plain post because the chat is private. */
export async function isSealRequired(response: Response | undefined): Promise<boolean> {
  if (response?.status !== 409) return false;
  const parsed = errorResponseSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => undefined),
  );
  return parsed.success && parsed.data.error.code === 'seal_required';
}

/** Codes an old gateway answers a sealed request with (400/415 class): treated as "not private". */
const OLD_GATEWAY_CODES = new Set(['bad_request', 'invalid_request', 'unsupported_file_type']);

/** The sealed request was refused because the chat is ordinary or the gateway is too old. */
export function isPlainFallbackCode(code: string | undefined): boolean {
  return code === 'not_private' || (code !== undefined && OLD_GATEWAY_CODES.has(code));
}

/** True when a sealed post was refused in a way that means: send it plain, as today. */
export async function shouldSendPlain(response: Response | undefined): Promise<boolean> {
  if (response === undefined || ![400, 409, 415].includes(response.status)) return false;
  const parsed = errorResponseSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => undefined),
  );
  if (!parsed.success) return false;
  const code = parsed.data.error.code;
  return response.status === 409 ? code === 'not_private' : isPlainFallbackCode(code);
}

/** Whether this computer has a phone it can seal to (otherwise it posts plain, marked). */
export function hasTrustedPhone(config: ConnectorConfig): boolean {
  return config.e2e?.devices.some((device) => device.kind === 'phone') === true;
}

export interface SealedPostOptions {
  /** Changes the saved private chat state under the cross-process lock (`updateE2e`). */
  store: (change: (current: E2eConfig) => E2eConfig) => Promise<E2eConfig | undefined>;
  config: ConnectorConfig;
  localAgent: string;
  text: string;
  /** Local files to seal and upload, in order. */
  paths: readonly string[];
  server: string | URL;
  token: string;
  /** The person's session on a shared server agent (as for a plain upload). */
  sessionScope?: string | undefined;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /**
   * For the CLI: a file that fails to upload (other than an ordinary chat or an old gateway)
   * throws instead of becoming a line, so nothing is posted. Replies and background results keep
   * the line.
   */
  strict?: true;
}

/**
 * Seals the computer's own message for a private chat (ADR-045): one seq reserved through the
 * store lock, the text cut in chunks the way a reply is, and each file sealed with its own key and
 * uploaded as an opaque blob. A file is listed only once the gateway answered with its id; one that
 * cannot be sent becomes a plain line in the sealed text. Nothing here logs, and neither a key nor
 * a file name reaches an error.
 */
export async function sealedPost(
  options: SealedPostOptions,
): Promise<{ sealed: SealedEnvelopeV1[]; fileIds: string[] }> {
  const unpaired = () => new PrivatePostError('private_post_unpaired', UNPAIRED_LINE);
  // The seq is reserved first, so no file is uploaded for a computer with no phone to read it.
  const saved = await options.store((current) => ({ ...current, seq: current.seq + 1 }));
  if (saved === undefined || !saved.devices.some((device) => device.kind === 'phone'))
    throw unpaired();
  const aad = fileAad({ accountId: options.config.connector_id, agentId: options.localAgent });
  const files: NonNullable<SealedPayload['files']> = [];
  const lines: string[] = [];
  for (const path of options.paths) {
    const name = cleanName(basename(path));
    const mime = mimeForName(name);
    // With strict these fail the way a plain upload does (uploadFile), so nothing is posted.
    if (mime === undefined) {
      if (options.strict === true)
        throw new UploadError(
          'unsupported_file_type',
          'Twring can send photos, PDFs and text files.',
        );
      lines.push(`Could not send ${name}: Twring can send photos, PDFs and text files.`);
      continue;
    }
    try {
      const size = (await stat(path)).size;
      if (size === 0) {
        if (options.strict === true) throw new UploadError('empty_file', 'The file is empty.');
        lines.push(`Could not send ${name}: it is empty.`);
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        if (options.strict === true)
          throw new UploadError('file_too_large', 'The file is too large (maximum 10 MB).');
        lines.push(`Could not send ${name}: it is larger than 10 MB.`);
        continue;
      }
      const data = await readFile(path);
      const key = newFileKey();
      const id = await uploadFile({
        server: options.server,
        token: options.token,
        localAgent: options.localAgent,
        bytes: sealFile(key, data, aad),
        name,
        sealed: true,
        sessionScope: options.sessionScope,
        clientId: randomUUID(),
        ...(options.signal !== undefined && { signal: options.signal }),
        ...(options.fetch !== undefined && { fetch: options.fetch }),
      });
      files.push({ file_id: id, key: base64urlEncode(key), name, mime, size: data.byteLength });
    } catch (error) {
      if (options.signal?.aborted)
        throw new PrivatePostError('cancelled', 'Message sending cancelled.');
      // An ordinary chat or an old gateway: the caller sends the whole message plain instead.
      if (error instanceof UploadError && isPlainFallbackCode(error.code))
        throw new PrivatePostError(
          'not_private',
          error.code === 'not_private'
            ? 'This chat is not private.'
            : 'The server could not take a sealed file.',
        );
      if (options.strict === true)
        throw error instanceof UploadError
          ? error
          : new UploadError('upload_failed', 'Could not send the file.');
      lines.push(
        error instanceof UploadError && error.code === 'file_too_large'
          ? `Could not send ${name}: it is larger than 10 MB.`
          : `Could not send ${name}.`,
      );
    }
  }
  const ctx: SealContext = {
    accountId: options.config.connector_id,
    agentId: options.localAgent,
    myDeviceId: saved.device_id,
    myPublic: saved.public_key,
    myPrivate: base64urlDecode(saved.private_key),
    trusted: saved.devices,
    seen: new ReplayWindow({}),
  };
  const text = [options.text, ...lines].filter((part) => part !== '').join('\n');
  const pieces = splitText(text, CHUNK_CHARS);
  const sealed = pieces.map((piece, index) => {
    const last = index === pieces.length - 1;
    const payload: SealedPayload = {
      text: piece,
      ...(last && files.length > 0 && { files }),
    };
    return sealOutgoing(
      ctx,
      payload,
      saved.seq,
      pieces.length > 1 ? { index, final: last } : undefined,
    );
  });
  return { sealed, fileIds: files.map((file) => file.file_id) };
}
