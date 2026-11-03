import { z } from 'zod';

/** Voice accounts a person can bring their own key for. */
export const speechProviderSchema = z.enum(['deepgram', 'cartesia', 'xai']);
export type SpeechProvider = z.infer<typeof speechProviderSchema>;

/** Voice accounts that can do the listening half of a call. */
export const listeningProviderSchema = z.enum(['deepgram', 'xai']);
export type ListeningProvider = z.infer<typeof listeningProviderSchema>;

/** `PUT /v1/me/speech-keys/listening`: which account listens when the person has both. */
export const speechListeningPutRequestSchema = z
  .object({ provider: listeningProviderSchema })
  .strict();
export type SpeechListeningPutRequest = z.infer<typeof speechListeningPutRequestSchema>;

/** `PUT /v1/me/speech-keys/:provider`. The key is printable ASCII with no spaces. */
export const speechKeyPutRequestSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(20)
      .max(200)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict();
export type SpeechKeyPutRequest = z.infer<typeof speechKeyPutRequestSchema>;

/** `GET /v1/me/speech-keys`: never the key itself, only its last four characters. */
export const speechKeyListResponseSchema = z.object({
  providers: z.array(
    z.object({
      provider: speechProviderSchema,
      added: z
        .object({
          last4: z.string().length(4),
          added_at: z.iso.datetime(),
          verified_at: z.iso.datetime(),
        })
        .nullable(),
    }),
  ),
  /** The account that listens on the next call. */
  listening: listeningProviderSchema,
  /** True when both listening accounts have a key, so the choice is the person's to make. */
  listening_choice: z.boolean(),
});
export type SpeechKeyListResponse = z.infer<typeof speechKeyListResponseSchema>;
