import { z } from 'zod';

import { e2eDeviceIdSchema } from './sealed-chat';
import { threadMessageIdSchema } from './threads';

/**
 * Re-wrapped message keys (C3 #11 Task 28, P4b ruling 9): a phone approved later reads older
 * private messages once a trusted phone wraps each message key again, from its own key to the
 * new phone's, under the message's own AAD. Kept apart from `sealed.keys`, which old clients read
 * with a strict schema and which names only the sender's wraps.
 */

/** Items per upload (one chat's history fits in one call). */
export const MAX_REWRAP_ITEMS = 2000;
/** Items per page when the new phone reads them. */
export const REWRAP_PAGE_SIZE = 500;

const wrappedSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(128);

export const sealedKeysUploadSchema = z
  .object({
    /** The approving phone (an active phone of the account). */
    device_id: e2eDeviceIdSchema,
    /** The phone the keys are for (an active device of the account). */
    for: e2eDeviceIdSchema,
    items: z
      .array(z.object({ message_id: threadMessageIdSchema, wrapped: wrappedSchema }).strict())
      .min(1)
      .max(MAX_REWRAP_ITEMS),
  })
  .strict();
export type SealedKeysUpload = z.infer<typeof sealedKeysUploadSchema>;

export const sealedRewrapSchema = z
  .object({ message_id: threadMessageIdSchema, by: e2eDeviceIdSchema, wrapped: wrappedSchema })
  .strict();
export type SealedRewrap = z.infer<typeof sealedRewrapSchema>;

export const sealedKeysPageSchema = z
  .object({
    items: z.array(sealedRewrapSchema).max(REWRAP_PAGE_SIZE),
    /** Pass as `after` for the next page; absent on the last page. */
    next: z
      .string()
      .regex(/^\d{1,12}$/)
      .optional(),
  })
  .strict();
export type SealedKeysPage = z.infer<typeof sealedKeysPageSchema>;
