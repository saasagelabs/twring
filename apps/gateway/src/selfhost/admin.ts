import { createHash, timingSafeEqual } from 'node:crypto';

import { personRoleSchema } from '@twring/contracts';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import type { PairingBook } from '../connectors/pairing';

import type { ServerIdentity } from './identity';
import type { SelfhostStores } from './people';
import type { PersonRemover } from './removal';
import { deviceSummary, type RingServiceProvider } from './routes';

/** The admin listener's address: inside the container only, never published. */
export const ADMIN_HOST = '127.0.0.1';
export const ADMIN_PORT = 8081;

export interface AdminServerOptions {
  /** `TWRING_ADMIN_TOKEN`. */
  token: string;
  stores: SelfhostStores;
  /** Removes a person the same way the app's admin removal does. */
  remover: PersonRemover;
  identity: ServerIdentity;
  spaceId: string;
  /** The connector pairing book, so the installer can link agents for a person. */
  pairings: PairingBook;
  /** What the ring service last said about this install, for `twring status`. */
  ringService?: RingServiceProvider;
}

const sha = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

/** Constant-time: both sides are hashed to the same length first. */
export function adminTokenMatches(expected: string, header: unknown): boolean {
  if (typeof header !== 'string') return false;
  const match = /^Bearer (\S+)$/.exec(header);
  return timingSafeEqual(sha(expected), sha(match?.[1] ?? '')) && match !== null;
}

const codeRequestSchema = z.object({ role: personRoleSchema }).strict();
const connectorCodeRequestSchema = z.object({ person_id: z.string().min(1).max(128) }).strict();

const fail = (reply: FastifyReply, status: number, message: string) =>
  reply.code(status).send({ error: message });

/**
 * The admin listener the `twring` command talks to (Ruling: admin listener on 127.0.0.1:8081),
 * so it changes people through the same in-process stores the server uses.
 */
export function buildAdminServer(options: AdminServerOptions): FastifyInstance {
  const { stores, spaceId } = options;
  const app = Fastify({ logger: false, bodyLimit: 4096 });

  app.addHook('onRequest', async (request, reply) => {
    if (!adminTokenMatches(options.token, request.headers.authorization)) {
      return fail(reply, 401, 'Wrong admin token.');
    }
  });

  app.post('/admin/codes', async (request, reply) => {
    const parsed = codeRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'Send {"role":"admin"} or {"role":"member"}.');
    const { code, expiresAt } = await stores.codes.mint(parsed.data.role, spaceId);
    return reply.code(201).send({ code, expires_at: expiresAt.toISOString() });
  });

  app.get<{ Querystring: { removed?: string } }>('/admin/people', async (request) => ({
    people: await Promise.all(
      (request.query.removed === '1'
        ? await stores.people.listRemoved(spaceId)
        : await stores.people.list(spaceId)
      ).map(async (p) => ({
        id: p.id,
        display_name: p.display_name,
        role: p.role,
        devices: (await stores.devices.listFor(p.id)).map(deviceSummary),
      })),
    ),
  }));

  app.delete<{ Params: { id: string }; Querystring: { purge?: string } }>(
    '/admin/people/:id',
    async (request, reply) => {
      const outcome = await options.remover.remove(request.params.id, {
        purge: request.query.purge === '1',
        log: request.log,
      });
      if (outcome === 'not_found') return fail(reply, 404, 'No such person.');
      if (outcome === 'last_admin') return fail(reply, 409, 'That is the last admin.');
      if (outcome === 'unavailable') return fail(reply, 503, 'Purge is not available.');
      return reply.code(204).send();
    },
  );

  app.get('/admin/status', async () => {
    const people = await stores.people.list(spaceId);
    const devices = await Promise.all(people.map((p) => stores.devices.listFor(p.id)));
    return {
      server_id: options.identity.id,
      people: people.length,
      admins: people.filter((p) => p.role === 'admin').length,
      devices: devices.reduce((sum, list) => sum + list.length, 0),
      ...(options.ringService !== undefined && { ring_service: await options.ringService() }),
    };
  });

  app.post('/admin/connector-code', async (request, reply) => {
    const parsed = connectorCodeRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'Send {"person_id":"..."}.');
    const person = await stores.people.get(parsed.data.person_id);
    if (person === undefined || person.removed_at !== undefined) {
      return fail(reply, 404, 'No such person.');
    }
    const pairing = options.pairings.create(person.id, { autoAgents: true });
    return reply
      .code(201)
      .send({ code: pairing.code, expires_at: new Date(pairing.expiresAt).toISOString() });
  });

  return app;
}

/** Binds the admin listener to the loopback address only. */
export async function startAdminListener(
  app: FastifyInstance,
  port: number = ADMIN_PORT,
): Promise<{ address: string; port: number }> {
  await app.listen({ host: ADMIN_HOST, port });
  const bound = app.server.address();
  if (bound === null || typeof bound === 'string') throw new Error('admin listener not bound');
  return { address: bound.address, port: bound.port };
}
