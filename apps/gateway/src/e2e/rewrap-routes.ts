import {
  agentIdSchema,
  e2eDeviceIdSchema,
  REWRAP_PAGE_SIZE,
  sealedKeysPageSchema,
  sealedKeysUploadSchema,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { devUserResolver, type UserResolver } from '../auth';
import { FixedWindowLimiter } from '../rate-limit';
import type { AgentRepository } from '../store/repositories';
import type { SqliteThreadStore } from '../threads/store';
import type { E2eDeviceStore } from './devices-store';
import { privateChatsAllowed } from './flag';
import type { GatewayErrorCode } from './guard';

/** 2,000 items of about 170 bytes each, with room to spare. */
const UPLOAD_BODY_LIMIT = 512 * 1024;

export interface SealedKeyRoutesOptions {
  env: Parameters<typeof privateChatsAllowed>[0];
  devices: Pick<E2eDeviceStore, 'get'>;
  store: Pick<SqliteThreadStore, 'addRewraps' | 'listRewraps'>;
  agents: Pick<AgentRepository, 'get'>;
  userFor?: UserResolver;
  writeRatePerMinute: number;
  readRatePerMinute: number;
}

const listQuerySchema = z
  .object({
    device_id: e2eDeviceIdSchema,
    after: z
      .string()
      .regex(/^\d{1,12}$/)
      .transform(Number)
      .optional(),
  })
  .strict();

const MESSAGES: Partial<Record<GatewayErrorCode, string>> = {
  private_chats_off: 'Private chats are not available for this account.',
  not_found: 'No such agent.',
  unknown_device: 'That phone is not set up for private chats any more.',
  unknown_message: 'A message is not in this private chat.',
  rate_limited: 'Too many tries. Wait a minute and try again.',
  bad_request: 'Invalid request.',
};

function sendError(reply: FastifyReply, status: number, code: GatewayErrorCode): FastifyReply {
  return reply.code(status).send({
    error: { code, message: MESSAGES[code] ?? 'Request refused.', request_id: reply.request.id },
  });
}

/**
 * Re-wrapped message keys for a phone approved later (C3 #11 Task 28, P4b ruling 9). The server
 * stores opaque wraps: it checks who may write and read them, never what they hold. Logs carry
 * ids and counts only.
 */
export function registerSealedKeyRoutes(app: FastifyInstance, options: SealedKeyRoutesOptions) {
  const userFor = options.userFor ?? devUserResolver;
  const writes = new FixedWindowLimiter(options.writeRatePerMinute, 60_000);
  const reads = new FixedWindowLimiter(options.readRatePerMinute, 60_000);
  const agentOk = async (userId: string, agentId: string) =>
    agentIdSchema.safeParse(agentId).success && Boolean(await options.agents.get(userId, agentId));

  app.post<{ Params: { agentId: string } }>(
    '/v1/agents/:agentId/sealed-keys',
    { bodyLimit: UPLOAD_BODY_LIMIT },
    async (request, reply) => {
      const userId = userFor(request);
      if (!privateChatsAllowed(options.env, userId))
        return sendError(reply, 404, 'private_chats_off');
      if (!writes.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
      const body = sealedKeysUploadSchema.safeParse(request.body);
      if (!body.success) return sendError(reply, 400, 'bad_request');
      const { agentId } = request.params;
      if (!(await agentOk(userId, agentId))) return sendError(reply, 404, 'not_found');
      // The caller must be an active phone; only a phone approves another (P4b ruling 1).
      if (options.devices.get(userId, body.data.device_id)?.kind !== 'phone')
        return sendError(reply, 404, 'not_found');
      if (
        body.data.for === body.data.device_id ||
        options.devices.get(userId, body.data.for) === undefined
      )
        return sendError(reply, 409, 'unknown_device');
      const result = options.store.addRewraps(userId, agentId, {
        by: body.data.device_id,
        forDevice: body.data.for,
        items: body.data.items,
      });
      if (result === 'unknown_message') return sendError(reply, 409, 'unknown_message');
      request.log.info(
        {
          event: 'e2e_rewraps_stored',
          device_id: body.data.device_id,
          for: body.data.for,
          count: body.data.items.length,
        },
        'e2e rewraps stored',
      );
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/v1/agents/:agentId/sealed-keys',
    async (request, reply) => {
      const userId = userFor(request);
      if (!privateChatsAllowed(options.env, userId))
        return sendError(reply, 404, 'private_chats_off');
      if (!reads.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) return sendError(reply, 400, 'bad_request');
      const { agentId } = request.params;
      if (!(await agentOk(userId, agentId))) return sendError(reply, 404, 'not_found');
      if (options.devices.get(userId, query.data.device_id) === undefined)
        return sendError(reply, 409, 'unknown_device');
      const page = options.store.listRewraps(userId, agentId, query.data.device_id, {
        after: query.data.after ?? 0,
        limit: REWRAP_PAGE_SIZE,
      });
      // A wrap made by a device removed since is never handed out, even if its rows linger.
      const items = page.items.filter((item) => options.devices.get(userId, item.by) !== undefined);
      return sealedKeysPageSchema.parse({
        items,
        ...(page.next !== undefined && { next: String(page.next) }),
      });
    },
  );
}
