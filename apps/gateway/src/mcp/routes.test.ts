/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await -- Fastify inject JSON and test doubles are intentionally dynamic. */
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGatewayEnv } from '@twring/config/gateway';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { buildApp } from '../app';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../auth';
import { MemoryCollection } from '../store/collection';
import { CollectionAgentRepository, type AgentRepository } from '../store/repositories';
import type { RingService } from '../ring/service';
import type { ThreadService } from '../threads/service';
import type { SqliteThreadStore } from '../threads/store';
import type { FileService } from '../files/service';
import type { fetchAgentFile } from '../files/fetch-agent-file';
import { displayName, mcpClientKind, McpContacts, type ConnectedAppBlock } from './contacts';
import { mcpTools, registerConnectedAppRoutes, registerMcpRoutes } from './routes';

const USER = '8f1c2a52-0000-4000-8000-000000000001';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const agents: AgentRepository = new CollectionAgentRepository(new MemoryCollection());
  const contacts = new McpContacts(agents, new MemoryCollection<ConnectedAppBlock>());
  const ring = {
    ring: vi.fn(async () => ({ invite: { id: 'inv_test' } })),
    settings: vi.fn(async () => ({ dnd: false, quiet_hours: null })),
    nowDate: () => new Date('2026-10-20T00:00:00.000Z'),
  };
  const delivered: Array<{ user: string; agent: string; text: string; key: string }> = [];
  const threads = {
    deleteAgent: vi.fn(() => Promise.resolve(1)),
    deliverResult: vi.fn(
      async (user: string, agent: string, input: { text: string; idempotencyKey: string }) => {
        delivered.push({ user, agent, text: input.text, key: input.idempotencyKey });
        return { messageId: 'msg_test', delivery: 'push' as const, created: true };
      },
    ),
  };
  const threadStore = {
    ownerReplies: vi.fn(async () => []),
    ownerReplyCount: vi.fn(async () => 0),
  };
  const fileUploads = vi.fn(async () => ({ file: { id: 'file_test' } }));
  const fetchFile = vi.fn<typeof fetchAgentFile>(async (url) => {
    if (url.includes('blocked')) throw new Error('blocked');
    return { bytes: Buffer.from('hello'), contentType: 'text/plain' };
  });
  threads.deliverResult.mockImplementation(async (user, agent, input) => {
    delivered.push({ user, agent, text: input.text, key: input.idempotencyKey });
    return { messageId: 'msg_test', delivery: 'push' as const, created: true };
  });
  registerMcpRoutes(app, {
    publicUrl: 'https://api.twring.com',
    supabaseUrl: 'https://project.supabase.co',
    authenticate: async (request) => {
      const token = request.headers.authorization;
      if (token !== 'Bearer app-a' && token !== 'Bearer app-b' && token !== 'Bearer app-c')
        throw new AuthError(401, 'auth_invalid', 'Invalid token.');
      return { id: USER, clientId: token?.slice('Bearer '.length) ?? 'app-a' };
    },
    contacts,
    agents,
    ring: ring as unknown as RingService,
    threads: threads as unknown as ThreadService,
    threadStore: threadStore as unknown as SqliteThreadStore,
    files: { upload: fileUploads } as unknown as FileService,
    fetchFile,
  });
  registerConnectedAppRoutes(app, {
    contacts,
    userFor: () => USER,
    threads: threads as unknown as ThreadService,
  });
  const post = (method: string, params?: unknown, id: string | number = 1, token = 'app-a') =>
    app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) },
    });
  return {
    app,
    agents,
    contacts,
    ring,
    threads,
    threadStore,
    delivered,
    fileUploads,
    fetchFile,
    post,
  };
}

describe('MCP transport and contacts', () => {
  it('names known clients with specific coding app names first', () => {
    for (const [raw, name, kind] of [
      ['Claude Code', 'Claude Code', 'claude-code'],
      ['claude-code', 'Claude Code', 'claude-code'],
      ['Codex CLI', 'Codex', 'codex'],
      ['Cursor', 'Cursor', 'cursor'],
      ['Gemini CLI', 'Gemini CLI', 'gemini-cli'],
      ['gemini-cli', 'Gemini CLI', 'gemini-cli'],
      ['Claude Desktop', 'Claude', 'claude'],
      ['OpenAI ChatGPT', 'ChatGPT', 'chatgpt'],
      ['xAI Grok', 'Grok', 'grok'],
      ['Gemini', 'Gemini', 'gemini'],
    ]) {
      expect(displayName(raw)).toBe(name);
      expect(mcpClientKind(raw)).toBe(kind);
    }
    expect(displayName('  Custom app  ')).toBe('Custom app');
    expect(displayName('x'.repeat(70))).toBe('x'.repeat(60));
    expect(displayName('  ')).toBe('AI app');
    expect(mcpClientKind('Custom app')).toBeUndefined();
    expect(mcpClientKind(undefined)).toBeUndefined();
  });
  it('keeps MCP and metadata hidden while the kill switch is off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cord-mcp-off-'));
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture({ CORD_DATA_DIR: dir })),
      onError: () => undefined,
    });
    apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode).toBe(404);
    expect((await app.inject('/.well-known/oauth-protected-resource')).statusCode).toBe(404);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    rmSync(dir, { recursive: true, force: true });
  });
  it('publishes metadata when enabled even before chat services are mounted', async () => {
    const env = loadGatewayEnv({
      ...gatewayEnvFixture(),
      CONNECTOR_MCP_ENABLED: 'true',
      AUTH_MODE: 'supabase',
      SUPABASE_URL: 'https://project.supabase.co',
      CORD_PUBLIC_URL: 'https://api.twring.com',
    });
    const app = buildApp({ env, onError: () => undefined });
    apps.push(app);
    expect((await app.inject('/.well-known/oauth-protected-resource')).json().resource).toBe(
      'https://api.twring.com/mcp',
    );
  });
  it('publishes metadata and challenges invalid tokens', async () => {
    const { app } = setup();
    const meta = await app.inject('/.well-known/oauth-protected-resource/mcp');
    expect(meta.statusCode).toBe(200);
    expect(meta.headers['cache-control']).toBe('public, max-age=3600');
    expect(meta.json()).toEqual({
      resource: 'https://api.twring.com/mcp',
      authorization_servers: ['https://project.supabase.co/auth/v1'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['openid', 'email', 'profile'],
      resource_name: 'Twring',
      resource_documentation: 'https://twring.com/connector',
    });
    const missing = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe(
      'Bearer resource_metadata="https://api.twring.com/.well-known/oauth-protected-resource"',
    );
    const bad = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer bad' },
      payload: {},
    });
    expect(bad.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('negotiates versions, maps names and keeps owner renames', async () => {
    const { agents, post } = setup();
    const first = await post('initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'Claude Desktop' },
    });
    expect(first.json().result.protocolVersion).toBe('2025-11-25');
    let contact = (await agents.list(USER))[0]!;
    expect(contact.name).toBe('Claude');
    expect(contact.mcp_client).toBe('claude');
    await agents.update(
      USER,
      contact.id,
      { name: 'My helper', name_set_by_owner: true },
      new Date(),
    );
    await post('initialize', { protocolVersion: 'older', clientInfo: { name: 'OpenAI ChatGPT' } });
    contact = (await agents.list(USER))[0]!;
    expect(contact.name).toBe('My helper');
    expect(contact.mcp_client).toBe('chatgpt');
    expect(
      (await post('initialize', { protocolVersion: 'older' })).json().result.protocolVersion,
    ).toBe('2025-06-18');
    await post('ping', undefined, 1, 'app-b');
    expect((await agents.list(USER)).length).toBe(2);
  });

  it('lists annotated tools and handles protocol errors', async () => {
    const { app, post } = setup();
    expect((await post('tools/list')).json().result.tools).toEqual(mcpTools);
    expect((await post('ping')).json().result).toEqual({});
    expect((await post('unknown')).json().error.code).toBe(-32601);
    expect((await post('tools/call', { name: 'ring_me', arguments: {} })).json().error.code).toBe(
      -32602,
    );
    const parse = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer app-a', 'content-type': 'application/json' },
      payload: '{',
    });
    expect(parse.json().error.code).toBe(-32700);
    const notification = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer app-a' },
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(notification.statusCode).toBe(202);
    expect(notification.body).toBe('');
    const get = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: 'Bearer app-a' },
    });
    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe('POST');
    const remove = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { authorization: 'Bearer app-a' },
    });
    expect(remove.statusCode).toBe(405);
    expect(remove.headers.allow).toBe('POST');
  });

  it('rings, explains refusals, and reports status', async () => {
    const { post, ring } = setup();
    expect(
      (await post('tools/call', { name: 'ring_me', arguments: { reason: 'Help now' } })).json()
        .result.content[0].text,
    ).toContain('Ringing now');
    expect(ring.ring).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Help now' }));
    for (const refused of [
      'agent_not_saved',
      'owner_unavailable',
      'owner_busy',
      'no_ring_phone',
      'ring_pending',
      'ring_rate_limited',
    ] as const) {
      ring.ring.mockResolvedValueOnce({ refused } as never);
      const response = await post('tools/call', {
        name: 'ring_me',
        arguments: { reason: 'Help now' },
      });
      expect(response.json().result.content[0].text).toContain('Use message_me instead.');
      if (refused === 'no_ring_phone')
        expect(response.json().result.content[0].text).toBe(
          "The owner's phone can't ring yet. Use message_me instead.",
        );
      expect(response.json().result.isError).toBeUndefined();
    }
    const status = await post('tools/call', { name: 'twring_status', arguments: {} });
    expect(status.json().result.structuredContent).toMatchObject({
      rings_available: true,
      unread_owner_messages: 0,
    });
    ring.settings.mockResolvedValueOnce({ dnd: true, quiet_hours: null });
    const muted = await post('tools/call', { name: 'twring_status', arguments: {} });
    expect(muted.json().result.structuredContent.rings_available).toBe(false);
  });

  it('sends a message, checks replies, and blocks a client', async () => {
    const { post, contacts, delivered, threadStore } = setup();
    const call = { name: 'message_me', arguments: { text: 'Hello' } };
    expect((await post('tools/call', call, 7)).json().result.content[0].text).toBe('Sent.');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.key).toMatch(/^mcp:[0-9a-f-]{36}$/);
    threadStore.ownerReplies.mockResolvedValueOnce([
      { id: 'msg_one', created_at: '2026-10-20T00:00:00.000Z', text: 'Reply', attachments: [] },
    ] as never);
    const replies = await post('tools/call', {
      name: 'check_replies',
      arguments: { since: '2026-10-19T00:00:00.000Z' },
    });
    expect(replies.json().result.structuredContent.replies[0].text).toBe('Reply');
    expect(replies.json().result.structuredContent.next_since).toBe('2026-10-20T00:00:00.000Z');
    await contacts.block(USER, 'app-a', async () => undefined);
    const blocked = await post('ping');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.headers['www-authenticate']).toBeUndefined();
    expect(blocked.body).toContain('This app was removed from Twring');
    await contacts.allow(USER, 'app-a');
    expect((await post('ping')).statusCode).toBe(200);
  });

  it('fetches files through the guarded fetch seam and reports a failed file', async () => {
    const { post, fileUploads, fetchFile, delivered } = setup();
    const sent = await post(
      'tools/call',
      {
        name: 'message_me',
        arguments: { files: [{ url: 'https://files.example/note.txt', name: 'note.txt' }] },
      },
      8,
    );
    expect(sent.json().result.content[0].text).toBe('Sent.');
    expect(fetchFile).toHaveBeenCalledOnce();
    expect(fileUploads).toHaveBeenCalledOnce();
    expect(delivered).toHaveLength(1);
    const bad = await post(
      'tools/call',
      {
        name: 'message_me',
        arguments: { files: [{ url: 'https://files.example/blocked', name: 'bad.txt' }] },
      },
      9,
    );
    expect(bad.json().result).toMatchObject({
      isError: true,
      content: [{ text: 'Could not attach bad.txt.' }],
    });
    const insecure = await post(
      'tools/call',
      {
        name: 'message_me',
        arguments: { files: [{ url: 'http://files.example/note.txt', name: 'unsafe.txt' }] },
      },
      10,
    );
    expect(insecure.json().result).toMatchObject({ isError: true });
    expect(delivered).toHaveLength(1);
  });

  it('limits requests and messages per contact and across apps', async () => {
    const { post } = setup();
    for (let i = 0; i < 30; i++) {
      expect(
        (await post('tools/call', { name: 'message_me', arguments: { text: `a${i}` } }, i, 'app-a'))
          .statusCode,
      ).toBe(200);
    }
    expect(
      (
        await post('tools/call', { name: 'message_me', arguments: { text: 'extra' } }, 31, 'app-a')
      ).json().error.code,
    ).toBe(-32000);
    for (let i = 0; i < 30; i++) {
      expect(
        (await post('tools/call', { name: 'message_me', arguments: { text: `b${i}` } }, i, 'app-b'))
          .statusCode,
      ).toBe(200);
    }
    const userLimit = await post(
      'tools/call',
      { name: 'message_me', arguments: { text: 'extra' } },
      1,
      'app-c',
    );
    expect(userLimit.statusCode).toBe(429);
    expect(userLimit.json().error.code).toBe(-32000);
    for (let i = 0; i < 119; i++)
      expect((await post('ping', undefined, i, 'app-c')).statusCode).toBe(200);
    const requestLimit = await post('ping', undefined, 121, 'app-c');
    expect(requestLimit.statusCode).toBe(429);
    expect(requestLimit.json().error.code).toBe(-32000);
  });

  it('returns a tool error for an unsafe file URL without delivering a message', async () => {
    const { post, delivered } = setup();
    const response = await post('tools/call', {
      name: 'message_me',
      arguments: { files: [{ url: 'http://example.com/file.pdf', name: 'file.pdf' }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.isError).toBe(true);
    expect(delivered).toHaveLength(0);
  });

  it('delivers every message even when a new client session reuses JSON-RPC ids', async () => {
    const { post, delivered } = setup();
    await post('tools/call', { name: 'message_me', arguments: { text: 'First' } }, 1);
    await post('tools/call', { name: 'message_me', arguments: { text: 'Second' } }, 1);
    expect(delivered.map((m) => m.text)).toEqual(['First', 'Second']);
    expect(new Set(delivered.map((m) => m.key)).size).toBe(2);
  });

  it('accepts any notification without an answer', async () => {
    const { app } = setup();
    for (const method of ['notifications/initialized', 'notifications/cancelled']) {
      const sent = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: 'Bearer app-a' },
        payload: { jsonrpc: '2.0', method, params: { requestId: 1 } },
      });
      expect(sent.statusCode).toBe(202);
    }
  });

  it('records last use at most once a minute', async () => {
    const { post, agents } = setup();
    await post('ping');
    const [first] = await agents.list(USER);
    await post('ping');
    const [second] = await agents.list(USER);
    expect(first?.last_used_at).toBeDefined();
    expect(second?.updated_at).toBe(first?.updated_at);
  });

  it('blocks and allows a client through the owner routes, removing its chat', async () => {
    const { app, post, agents, threads, contacts } = setup();
    await post('initialize', { clientInfo: { name: 'Claude' } });
    const list = await app.inject('/v1/me/connected-apps');
    expect(list.json().apps).toMatchObject([
      { client_id: 'app-a', name: 'Claude', blocked: false },
    ]);
    const blocked = await app.inject({ method: 'POST', url: '/v1/me/connected-apps/app-a/block' });
    expect(blocked.statusCode).toBe(204);
    expect(threads.deleteAgent).toHaveBeenCalledOnce();
    expect(await agents.list(USER)).toHaveLength(0);
    expect((await post('ping')).statusCode).toBe(403);
    expect((await app.inject('/v1/me/connected-apps')).json().apps).toMatchObject([
      { client_id: 'app-a', name: 'Claude', blocked: true },
    ]);
    await app.inject({ method: 'POST', url: '/v1/me/connected-apps/app-a/allow' });
    expect((await post('ping')).statusCode).toBe(200);
    await contacts.deleteAllForUser(USER);
    expect((await contacts.list(USER)).apps).toHaveLength(1);
  });
});

describe('MCP add_words', () => {
  async function contactOf(t: ReturnType<typeof setup>) {
    await t.post('ping');
    const [contact] = await t.agents.list(USER);
    return contact!;
  }

  it('is listed as a safe, repeatable tool', () => {
    const tool = mcpTools.find((item) => item.name === 'add_words');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(tool?.inputSchema).toMatchObject({ required: ['words'] });
  });

  it('teaches this app’s calls words to hear right, after the owner’s own', async () => {
    const t = setup();
    const contact = await contactOf(t);
    await t.agents.update(USER, contact.id, { keyterms: ['Gowri'] }, new Date());
    const res = await t.post('tools/call', {
      name: 'add_words',
      arguments: { words: ['Lightsail', 'gowri'] },
    });
    expect(res.json().result.content[0].text).toBe(
      'From the next call or voice note, Twring will listen for: Gowri, Lightsail.',
    );
    expect((await t.agents.get(USER, contact.id))?.keyterms).toEqual(['Gowri', 'Lightsail']);
  });

  it('says which words did not fit a full list', async () => {
    const t = setup();
    const contact = await contactOf(t);
    const full = Array.from({ length: 39 }, (_, i) => `word${i}`);
    await t.agents.update(USER, contact.id, { keyterms: full }, new Date());
    const res = await t.post('tools/call', {
      name: 'add_words',
      arguments: { words: ['Kubernetes', 'Lightsail'] },
    });
    const text = String(res.json().result.content[0].text);
    expect(text).toContain('Kubernetes.');
    expect(text).toContain('The list is full (40 words); not added: Lightsail.');
    expect((await t.agents.get(USER, contact.id))?.keyterms).toHaveLength(40);
  });

  it('refuses anything that is not a short plain word or phrase', async () => {
    const t = setup();
    for (const args of [{}, { words: [] }, { words: ['a\nb'] }, { words: ['x'.repeat(51)] }]) {
      const res = await t.post('tools/call', { name: 'add_words', arguments: args });
      expect(res.json().error?.code, JSON.stringify(args)).toBe(-32602);
    }
  });
});
