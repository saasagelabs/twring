import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  addWordsInputSchema,
  checkRepliesInputSchema,
  messageMeInputSchema,
  ringMeInputSchema,
  twringStatusInputSchema,
  mcpClientIdSchema,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, type McpIdentity } from '../auth';
import { FixedWindowLimiter } from '../rate-limit';
import { ownerUnavailable, type RingRefusal, type RingService } from '../ring/service';
import type { ThreadService } from '../threads/service';
import type { SqliteThreadStore } from '../threads/store';
import type { FileService } from '../files/service';
import { fetchAgentFile } from '../files/fetch-agent-file';
import { sniffFile } from '../files/sniff';
import type { AgentRepository } from '../store/repositories';
import { addAgentWords } from '../agents/words';
import { ConnectedAppBlocked, type McpContacts } from './contacts';

type RpcId = string | number | null;
const rpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
const versions = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const schemas = {
  ring_me: {
    type: 'object',
    properties: { reason: { type: 'string', minLength: 1, maxLength: 140 } },
    required: ['reason'],
    additionalProperties: false,
  },
  message_me: {
    type: 'object',
    properties: {
      text: { type: 'string', maxLength: 4000 },
      files: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri', pattern: '^https://' },
            name: { type: 'string', maxLength: 120 },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
    },
    anyOf: [
      { required: ['text'], properties: { text: { minLength: 1 } } },
      { required: ['files'], properties: { files: { minItems: 1 } } },
    ],
    additionalProperties: false,
  },
  check_replies: {
    type: 'object',
    properties: { since: { type: 'string', format: 'date-time' } },
    additionalProperties: false,
  },
  twring_status: { type: 'object', properties: {}, additionalProperties: false },
  add_words: {
    type: 'object',
    properties: {
      words: {
        type: 'array',
        minItems: 1,
        maxItems: 40,
        items: { type: 'string', minLength: 1, maxLength: 50 },
      },
    },
    required: ['words'],
    additionalProperties: false,
  },
} as const;
export const mcpTools = [
  {
    name: 'ring_me',
    description:
      "Use when something needs the owner's attention now. Rings their phone and opens this chat when answered.",
    inputSchema: schemas.ring_me,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'message_me',
    description: 'Use to send an update or files when a live ring is unnecessary or unavailable.',
    inputSchema: schemas.message_me,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'check_replies',
    description: 'Use after a ring or message to read what the owner replied in this chat.',
    inputSchema: schemas.check_replies,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'twring_status',
    description: 'Use before ringing to check availability and unread replies.',
    inputSchema: schemas.twring_status,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'add_words',
    description:
      'Use when Twring mishears a word the owner says in a voice note or call: their name, people, projects, places or product names. Applies from the next one. Up to 40; the owner can change them in the Twring app.',
    inputSchema: schemas.add_words,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const;

const refusal: Record<RingRefusal, string> = {
  agent_not_saved: 'This AI app is no longer connected. Use message_me instead.',
  owner_unavailable: 'Do Not Disturb or quiet hours is on. Use message_me instead.',
  owner_busy: 'The owner is busy on a call. Use message_me instead.',
  no_ring_phone: "The owner's phone can't ring yet. Use message_me instead.",
  ring_pending: 'The phone is already ringing. Use message_me instead.',
  ring_rate_limited: 'The ring limit of 6 per hour was reached. Use message_me instead.',
};
const result = (text: string, extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'text', text }],
  ...extra,
});
const rpcError = (id: RpcId, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});
const rpcResult = (id: RpcId, value: unknown) => ({ jsonrpc: '2.0', id, result: value });

export interface McpRoutesOptions {
  publicUrl: string;
  supabaseUrl: string;
  authenticate(request: FastifyRequest): Promise<McpIdentity>;
  contacts: McpContacts;
  agents: AgentRepository;
  threads: ThreadService;
  threadStore: SqliteThreadStore;
  ring: RingService;
  files?: FileService;
  fileFetchEnv?: 'development' | 'staging' | 'production';
  fetchFile?: typeof fetchAgentFile;
}

export function registerMcpRoutes(app: FastifyInstance, options: McpRoutesOptions): void {
  registerMcpMetadata(app, options.publicUrl, options.supabaseUrl);
  const requestLimit = new FixedWindowLimiter(120, 60_000);
  const contactMessages = new FixedWindowLimiter(30, 60_000);
  const userMessages = new FixedWindowLimiter(60, 60_000);
  const auth = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await options.authenticate(request);
      if (!requestLimit.tryAcquire(`${identity.id}\0${identity.clientId}`)) {
        reply.code(429).send(rpcError(null, -32000, 'Too many requests. Try again in a minute.'));
        return undefined;
      }
      const contact = await options.contacts.getOrCreate(identity.id, identity.clientId);
      await options.contacts.touch(identity.id, contact);
      return { identity, contact };
    } catch (error) {
      // Removed by the owner: signing in again can't fix that, so no token challenge (403, not 401).
      if (error instanceof ConnectedAppBlocked) {
        reply.code(403).send({ error: error.message });
        return undefined;
      }
      const missing = request.headers.authorization === undefined;
      const challenge = `Bearer resource_metadata="${options.publicUrl}/.well-known/oauth-protected-resource"${missing ? '' : ', error="invalid_token"'}`;
      const failure =
        error instanceof AuthError
          ? error
          : new AuthError(503, 'auth_unavailable', 'Authentication unavailable.');
      reply
        .header('www-authenticate', challenge)
        .code(failure.status)
        .send({ error: failure.message });
      return undefined;
    }
  };
  app.get('/mcp', async (request, reply) => {
    if (!(await auth(request, reply))) return reply;
    return reply.header('allow', 'POST').code(405).send();
  });
  app.delete('/mcp', async (request, reply) => {
    if (!(await auth(request, reply))) return reply;
    return reply.header('allow', 'POST').code(405).send();
  });
  app.register((scope, _opts, done) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, next) => {
        try {
          next(null, JSON.parse(body as string));
        } catch {
          next(null, Symbol.for('mcp.parse_error'));
        }
      },
    );
    scope.post('/mcp', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      const caller = await auth(request, reply);
      if (!caller) return reply;
      const { identity, contact: agent } = caller;
      if (request.body === Symbol.for('mcp.parse_error'))
        return reply.send(rpcError(null, -32700, 'Parse error'));
      const parsed = rpcSchema.safeParse(request.body);
      if (!parsed.success) return reply.send(rpcError(null, -32600, 'Invalid Request'));
      const rpc = parsed.data;
      const fail = (code: number, message: string) => rpcError(rpc.id ?? null, code, message);
      // Notifications (no id) get no answer: initialized, cancelled, progress and any later ones.
      if (rpc.id === undefined) return reply.code(202).send();
      if (rpc.method === 'initialize') {
        const params = z
          .object({
            protocolVersion: z.string().optional(),
            clientInfo: z.object({ name: z.string().optional() }).passthrough().optional(),
          })
          .passthrough()
          .safeParse(rpc.params);
        if (!params.success) return fail(-32602, 'Invalid params');
        await options.contacts.recordName(identity.id, agent, params.data.clientInfo?.name);
        return rpcResult(rpc.id ?? null, {
          protocolVersion: versions.has(params.data.protocolVersion ?? '')
            ? params.data.protocolVersion
            : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'twring', title: 'Twring', version: '0.0.0' },
          instructions:
            'Ring the owner when attention is needed now. Message them for updates or files, then check replies later. A ring opens this chat when answered.',
        });
      }
      if (rpc.method === 'ping') return rpcResult(rpc.id ?? null, {});
      if (rpc.method === 'tools/list') return rpcResult(rpc.id ?? null, { tools: mcpTools });
      if (rpc.method !== 'tools/call') return fail(-32601, 'Method not found');
      const call = z
        .object({ name: z.string(), arguments: z.unknown().optional() })
        .safeParse(rpc.params);
      if (!call.success) return fail(-32602, 'Invalid params');
      const args = call.data.arguments ?? {};
      const name = call.data.name;
      const loggedTool = mcpTools.some((tool) => tool.name === name) ? name : 'unknown';
      const logTool = (outcome: string) =>
        request.log.info(
          { event: 'mcp_tool', client_id: identity.clientId, tool: loggedTool, outcome },
          'mcp tool',
        );
      logTool('started');
      let outcome = 'ok';
      let output: ReturnType<typeof result>;
      if (name === 'ring_me') {
        const input = ringMeInputSchema.safeParse(args);
        if (!input.success) {
          logTool('invalid_params');
          return fail(-32602, 'Invalid params');
        }
        const placed = await options.ring.ring({
          userId: identity.id,
          agentId: agent.id,
          agentName: agent.name,
          reason: input.data.reason,
        });
        output = result(
          'refused' in placed
            ? refusal[placed.refused]
            : "Ringing now. If they answer, they'll hear your reason and can reply in your Twring chat; use check_replies later.",
        );
        if ('refused' in placed) outcome = placed.refused;
      } else if (name === 'message_me') {
        const input = messageMeInputSchema.safeParse(args);
        if (!input.success) {
          const candidate =
            typeof args === 'object' && args !== null && 'files' in args ? args.files : undefined;
          const badUrl =
            Array.isArray(candidate) &&
            candidate.some(
              (file: unknown) =>
                typeof file === 'object' &&
                file !== null &&
                'url' in file &&
                typeof file.url === 'string' &&
                !z.url({ protocol: /^https$/ }).safeParse(file.url).success,
            );
          if (badUrl) {
            logTool('file_error');
            return rpcResult(
              rpc.id,
              result('Could not attach the file: its URL must use HTTPS.', { isError: true }),
            );
          }
          logTool('invalid_params');
          return fail(-32602, 'Invalid params');
        }
        if (
          !contactMessages.tryAcquire(`${identity.id}\0${identity.clientId}`) ||
          !userMessages.tryAcquire(identity.id)
        ) {
          logTool('rate_limited');
          return reply.code(429).send(fail(-32000, 'Too many requests. Try again in a minute.'));
        }
        // A fresh key per call: JSON-RPC ids restart at 1 in every new client session, so keying
        // on them would silently swallow later messages as duplicates.
        const key = `mcp:${randomUUID()}`;
        const fileIds: string[] = [];
        for (const [index, file] of (input.data.files ?? []).entries()) {
          const name = file.name || `file ${index + 1}`;
          try {
            if (!options.files) throw new Error('Files are unavailable');
            const fetched = await (options.fetchFile ?? fetchAgentFile)(
              file.url,
              AbortSignal.timeout(20_000),
              { env: options.fileFetchEnv ?? 'production' },
            );
            const type = sniffFile(fetched.bytes, fetched.contentType, name);
            if (!type) throw new Error('Unsupported file type');
            const saved = await options.files.upload({
              userId: identity.id,
              agentId: agent.id,
              clientId: `${key}:${index}`,
              name,
              mimeType: type.mimeType,
              bytes: fetched.bytes,
              direction: 'agent',
              ...('width' in type && { width: type.width }),
              ...('height' in type && { height: type.height }),
            });
            fileIds.push(saved.file.id);
          } catch {
            output = result(`Could not attach ${name}.`, { isError: true });
            logTool('file_error');
            return rpcResult(rpc.id ?? null, output);
          }
        }
        await options.threads.deliverResult(identity.id, agent.id, {
          text: input.data.text ?? '',
          origin: 'agent',
          idempotencyKey: key,
          ...(fileIds.length && { fileIds }),
          target: { agentName: agent.name },
        });
        output = result('Sent.');
      } else if (name === 'check_replies' || name === 'twring_status') {
        const input =
          name === 'check_replies'
            ? checkRepliesInputSchema.safeParse(args)
            : twringStatusInputSchema.safeParse(args);
        if (!input.success) {
          logTool('invalid_params');
          return fail(-32602, 'Invalid params');
        }
        if (name === 'check_replies') {
          const since = 'since' in input.data ? input.data.since : undefined;
          const selected = await options.threadStore.ownerReplies(
            identity.id,
            agent.id,
            since,
            since ? 20 : 10,
          );
          const replies = selected.map((m) => ({
            id: m.id,
            time: m.created_at,
            text: m.text,
            attachments: (m.attachments ?? []).map((f) => ({ name: f.name, type: f.mime_type })),
          }));
          const next_since = selected.at(-1)?.created_at ?? since ?? null;
          await options.agents.update(
            identity.id,
            agent.id,
            { last_replies_checked_at: new Date().toISOString() },
            new Date(),
          );
          output = result(
            replies.length
              ? replies.map((m) => `${m.time}: ${m.text || '[attachment]'}`).join('\n')
              : 'No new replies.',
            { structuredContent: { replies, next_since } },
          );
        } else {
          const available = !ownerUnavailable(
            await options.ring.settings(identity.id),
            options.ring.nowDate(),
          );
          const unread = await options.threadStore.ownerReplyCount(
            identity.id,
            agent.id,
            agent.last_replies_checked_at,
          );
          output = result(
            `${agent.name}. Rings ${available ? 'can get through' : 'are muted by Do Not Disturb or quiet hours'}. ${unread} unread owner messages.`,
            {
              structuredContent: {
                name: agent.name,
                rings_available: available,
                unread_owner_messages: unread,
              },
            },
          );
        }
      } else if (name === 'add_words') {
        const input = addWordsInputSchema.safeParse(args);
        if (!input.success) {
          logTool('invalid_params');
          return fail(-32602, 'Invalid params');
        }
        const added = await addAgentWords(
          options.agents,
          identity.id,
          () => options.agents.get(identity.id, agent.id),
          input.data.words,
          new Date(),
        );
        if (!added.ok) {
          outcome = added.reason;
          output = result(
            added.reason === 'not_found'
              ? 'This AI app is no longer connected to Twring.'
              : 'The word list is changing right now. Try again.',
            { isError: true },
          );
        } else {
          const full = added.notAdded.length
            ? ` The list is full (40 words); not added: ${added.notAdded.join(', ')}. The owner can remove words in the Twring app.`
            : '';
          output = result(
            `From the next call or voice note, Twring will listen for: ${added.words.join(', ')}.${full}`,
          );
        }
      } else {
        logTool('unknown_tool');
        return fail(-32602, 'Unknown tool');
      }
      logTool(outcome);
      return rpcResult(rpc.id ?? null, output);
    });
    done();
  });
}

export function registerConnectedAppRoutes(
  app: FastifyInstance,
  options: {
    contacts: McpContacts;
    userFor(request: FastifyRequest): string;
    threads: ThreadService;
  },
): void {
  app.get('/v1/me/connected-apps', (request) => options.contacts.list(options.userFor(request)));
  app.post<{ Params: { clientId: string } }>(
    '/v1/me/connected-apps/:clientId/block',
    async (request, reply) => {
      if (!mcpClientIdSchema.safeParse(request.params.clientId).success)
        return reply.code(400).send({ error: 'Invalid client id.' });
      const userId = options.userFor(request);
      await options.contacts.block(userId, request.params.clientId, (agentId) =>
        options.threads.deleteAgent(userId, agentId).then(() => undefined),
      );
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { clientId: string } }>(
    '/v1/me/connected-apps/:clientId/allow',
    async (request, reply) => {
      if (!mcpClientIdSchema.safeParse(request.params.clientId).success)
        return reply.code(400).send({ error: 'Invalid client id.' });
      await options.contacts.allow(options.userFor(request), request.params.clientId);
      return reply.code(204).send();
    },
  );
}

export function registerMcpMetadata(
  app: FastifyInstance,
  publicUrl: string,
  supabaseUrl: string,
): void {
  const metadata = {
    resource: `${publicUrl}/mcp`,
    authorization_servers: [`${supabaseUrl.replace(/\/+$/, '')}/auth/v1`],
    bearer_methods_supported: ['header'],
    scopes_supported: ['openid', 'email', 'profile'],
    resource_name: 'Twring',
    resource_documentation: 'https://twring.com/connector',
  };
  app.get('/.well-known/oauth-protected-resource', (_request, reply) =>
    reply.header('cache-control', 'public, max-age=3600').send(metadata),
  );
  app.get('/.well-known/oauth-protected-resource/mcp', (_request, reply) =>
    reply.header('cache-control', 'public, max-age=3600').send(metadata),
  );
}
