import {
  callHistoryItemSchema,
  callHistoryResponseSchema,
  type CallHistoryItem,
} from '@twring/contracts';
import { z } from 'zod';

/**
 * "The agent rings you": request, response, and push payloads, mirroring the gateway API spec.
 * Kept here until they move into @twring/contracts; swap the imports then.
 */

const id = z.string().min(1).max(128);
const isoTime = z.iso.datetime({ offset: true });

export const DECLINE_NOTE_MAX = 60;

// Devices

export const registerDeviceRequestSchema = z.object({
  /** The ring token: FCM on Android, the PushKit VoIP token on iOS. */
  fcm_token: z.string().min(1).max(4096),
  platform: z.enum(['android', 'ios']),
  app_variant: z.enum(['development', 'staging', 'production']),
  /** iOS: the alert token for messages and missed rings. */
  apns_token: z.string().min(32).max(400).optional(),
});
export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>;

// Ring settings

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const quietHoursSchema = z.object({
  enabled: z.boolean(),
  start: clock,
  end: clock,
  tz: z.string().min(1).max(64),
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

export const ringSettingsSchema = z.object({
  dnd: z.boolean(),
  after_call_result: z.enum(['ring', 'message']).optional(),
  quiet_hours: quietHoursSchema.nullable(),
});
export type RingSettings = z.infer<typeof ringSettingsSchema>;

// Invites

export const inviteStatusSchema = z.enum([
  'pending',
  'answered',
  'declined',
  'missed',
  'cancelled',
]);
export type InviteStatus = z.infer<typeof inviteStatusSchema>;

export const inviteSchema = z.object({
  invite_id: id,
  agent_id: id,
  agent_name: z.string(),
  reason: z.string(),
  status: inviteStatusSchema,
  expires_at: isoTime,
  server_time: isoTime,
});
export type Invite = z.infer<typeof inviteSchema>;

export const inviteListResponseSchema = z.object({ invites: z.array(inviteSchema) });

/** `POST /v1/invites/:id/decline`: a quick reply ("busy", "outside", "text") or typed text. */
export const declineRequestSchema = z.object({
  note: z.string().trim().min(1).max(DECLINE_NOTE_MAX).optional(),
});
export type DeclineRequest = z.infer<typeof declineRequestSchema>;

/** Answer errors besides the ordinary call errors. Told apart by HTTP status as well as code. */
export const INVITE_EXPIRED = 'invite_expired';
export const INVITE_ALREADY_HANDLED = 'invite_already_handled';

// Push (FCM data messages: every value is a string)

export const ringPushSchema = z.object({
  type: z.literal('cord.ring'),
  invite_id: id,
  agent_id: id,
  agent_name: z.string().max(200),
  reason: z.string().max(1000),
  expires_at: isoTime,
  server_time: isoTime,
});
export type RingPush = z.infer<typeof ringPushSchema>;

export const ringCancelPushSchema = z.object({
  type: z.literal('cord.ring_cancel'),
  invite_id: id,
  status: z.string().max(32),
});
export type RingCancelPush = z.infer<typeof ringCancelPushSchema>;

export const pushSchema = z.discriminatedUnion('type', [ringPushSchema, ringCancelPushSchema]);
export type Push = z.infer<typeof pushSchema>;

/** A push payload from the native side, or undefined when it is not one of ours. */
export function parsePush(data: unknown): Push | undefined {
  const parsed = pushSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

// Call history

/**
 * Calls and rings nobody answered share one item shape (@twring/contracts, ADR-024): a missed ring
 * has `kind: 'missed_invite'`, the invite id as `call_id`, `reason`, and outcome `missed`.
 */
export const historyEntrySchema = callHistoryItemSchema;
export type HistoryEntry = CallHistoryItem;
export type MissedInviteHistoryItem = HistoryEntry & { kind: 'missed_invite' };

export const historyResponseSchema = callHistoryResponseSchema;
