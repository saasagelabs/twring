import { z } from 'zod';
import { agentProtocolSchema, callFeedbackIssueSchema, callIdSchema } from '@twring/contracts';

import type { Collection } from '../store/collection';

export const feedbackRecordSchema = z.object({
  call_id: callIdSchema,
  user_id: z.string().min(1),
  agent_id: z.string(),
  protocol: agentProtocolSchema.optional(),
  rating: z.number().int().min(1).max(5),
  issues: z.array(callFeedbackIssueSchema),
  note: z.string().max(280).optional(),
  app_version: z.string().max(100).optional(),
  created_at: z.iso.datetime(),
});
export type FeedbackRecord = z.infer<typeof feedbackRecordSchema>;

export class FeedbackStore {
  constructor(private readonly rows: Collection<FeedbackRecord>) {}

  upsert(record: FeedbackRecord): Promise<void> {
    return this.rows.update((items) => ({
      items: [...items.filter((item) => item.call_id !== record.call_id), record],
      result: undefined,
    }));
  }

  deleteAllForUser(userId: string): Promise<number> {
    return this.rows.update((items) => {
      const kept = items.filter((item) => item.user_id !== userId);
      return { items: kept, result: items.length - kept.length };
    });
  }
}
