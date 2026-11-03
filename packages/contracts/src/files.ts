import { z } from 'zod';

/** Images and files in chats. Owner decisions 2026-10-14. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
/** Stored per person, both directions together (wave 1: 100 MB while one disk holds everything). */
export const FILE_QUOTA_BYTES = 100 * 1024 * 1024;
/** New files per person per UTC day, both directions together. */
export const FILES_PER_DAY = 100;
export const MAX_FILE_NAME_CHARS = 120;
/** How long a signed link handed to an agent stays valid. */
export const FILE_LINK_TTL_MS = 15 * 60_000;

export const fileIdSchema = z.string().regex(/^fil_[a-z2-7]{20}$/);

/** The only types stored. The gateway checks the bytes, not just this label. */
export const fileMimeTypeSchema = z.enum([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);
export type FileMimeType = z.infer<typeof fileMimeTypeSchema>;

/** A file on a chat message, as the app sees it. Downloads use the app's sign-in. */
export const attachmentSchema = z.object({
  id: fileIdSchema,
  name: z.string().min(1).max(MAX_FILE_NAME_CHARS),
  mime_type: fileMimeTypeSchema,
  size_bytes: z.number().int().min(1).max(MAX_FILE_BYTES),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * `POST /v1/agents/:agentId/files?client_id=…&name=…` with the raw bytes and the file's
 * content type. Repeating a `client_id` returns the same file.
 */
export const fileUploadQuerySchema = z
  .object({ client_id: z.uuid(), name: z.string().min(1).max(255) })
  .strict();
export const fileUploadResponseSchema = z.object({ file: attachmentSchema });
export type FileUploadResponse = z.infer<typeof fileUploadResponseSchema>;

/**
 * A file on a turn, as an agent receives it: a signed link that works without other credentials
 * until `expires_at`. Optional on the wire; agents that predate it ignore it. AGENT_ADAPTER_SPEC §20–22.
 */
export const turnAttachmentSchema = z.object({
  id: fileIdSchema,
  name: z.string().min(1).max(MAX_FILE_NAME_CHARS),
  mime_type: fileMimeTypeSchema,
  size_bytes: z.number().int().min(1).max(MAX_FILE_BYTES),
  url: z.url({ protocol: /^https?$/ }).max(2048),
  expires_at: z.iso.datetime(),
});
export type TurnAttachment = z.infer<typeof turnAttachmentSchema>;
export const turnAttachmentsSchema = z.array(turnAttachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE);
