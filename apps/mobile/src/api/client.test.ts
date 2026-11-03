import { errorCodeSchema } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, createTwringApi, type TimerApi } from './client';
import { apiErrorCopy } from './errors';

const AGENT = {
  id: 'agt_abcdefghij0123456789',
  name: 'Operator',
  protocol: 'cord-native',
  endpoint_url: 'wss://agent.example.com/cord',
  voice_id: 'flux-thalia-en',
  keyterms: [],
  has_credential: true,
  status: 'ready',
  created_at: '2026-09-20T10:00:00.000Z',
  updated_at: '2026-09-20T10:00:00.000Z',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class ManualTimers implements TimerApi {
  fns: (() => void)[] = [];
  delays: number[] = [];
  setTimeout(fn: () => void, ms: number) {
    this.fns.push(fn);
    this.delays.push(ms);
    return this.fns.length - 1;
  }
  clearTimeout() {}
  fire() {
    this.fns.forEach((fn) => fn());
  }
}

function client(respond: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const timers = new ManualTimers();
  const api = createTwringApi({
    baseUrl: 'https://api.cord.invalid/',
    timers,
    fetch: (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  });
  return { api, calls, timers };
}

/** A fetch that only settles when aborted. */
const hanging = (_url: string, init: RequestInit) =>
  new Promise<Response>((_, reject) =>
    init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
  );

describe('cord api client', () => {
  it('reads the server and people, makes a teammate code and removes a person', async () => {
    const at = '2026-10-31T10:00:00.000Z';
    const { api, calls } = client((url, init) => {
      if (url.endsWith('/v1/server')) {
        return Promise.resolve(
          json(200, {
            server_id: 'srv_' + 'a'.repeat(32),
            name: 'Home',
            mode: 'selfhost',
            audio: 'own',
            ring_service: { state: 'unknown' },
          }),
        );
      }
      if (url.endsWith('/v1/people')) {
        return Promise.resolve(
          json(200, { people: [{ id: 'p1', display_name: 'Asha', role: 'admin', devices: [] }] }),
        );
      }
      if (url.endsWith('/v1/people/codes')) {
        return Promise.resolve(json(201, { code: 'ABCD-EFGH', expires_at: at }));
      }
      return Promise.resolve(new Response(null, { status: init.method === 'DELETE' ? 204 : 200 }));
    });
    expect((await api.serverInfo()).ring_service).toEqual({ state: 'unknown' });
    expect((await api.listPeople())[0]?.display_name).toBe('Asha');
    expect(await api.createMemberCode()).toEqual({ code: 'ABCD-EFGH', expires_at: at });
    await api.removePerson('p 2');
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['GET', 'https://api.cord.invalid/v1/server'],
      ['GET', 'https://api.cord.invalid/v1/people'],
      ['POST', 'https://api.cord.invalid/v1/people/codes'],
      ['DELETE', 'https://api.cord.invalid/v1/people/p%202'],
    ]);
  });

  it('lists, blocks and allows connected apps through validated responses', async () => {
    const { api, calls } = client((url) =>
      Promise.resolve(
        url.endsWith('/v1/me/connected-apps')
          ? json(200, { apps: [{ client_id: 'claude:app', name: 'Claude', blocked: false }] })
          : json(200, { ok: true }),
      ),
    );
    expect(await api.listConnectedApps()).toEqual([
      { client_id: 'claude:app', name: 'Claude', blocked: false },
    ]);
    await api.blockConnectedApp('claude:app');
    await api.allowConnectedApp('claude:app');
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['GET', 'https://api.cord.invalid/v1/me/connected-apps'],
      ['POST', 'https://api.cord.invalid/v1/me/connected-apps/claude%3Aapp/block'],
      ['POST', 'https://api.cord.invalid/v1/me/connected-apps/claude%3Aapp/allow'],
    ]);
    const bad = client(() =>
      Promise.resolve(
        json(200, { apps: [{ client_id: 'bad/slash', name: 'Bad', blocked: false }] }),
      ),
    );
    await expect(bad.api.listConnectedApps()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('parses both ring answer modes and rejects insecure call media', async () => {
    const chat = client(() => Promise.resolve(json(200, { mode: 'chat', agent_id: AGENT.id })));
    await expect(chat.api.answerInvite('inv_abcdefghijklmnopqrstuvwxyz')).resolves.toEqual({
      mode: 'chat',
      agentId: AGENT.id,
    });
    const callBody = {
      mode: 'call',
      call_id: 'call_abcdefghij0123456789',
      session_id: 'sess_abcdefghij0123456789',
      livekit: { url: 'wss://media.example.com', token: 'token', room: 'room' },
      expires_at: '2026-10-20T00:00:00.000Z',
    };
    const call = client(() => Promise.resolve(json(200, callBody)));
    await expect(call.api.answerInvite('inv_abcdefghijklmnopqrstuvwxyz')).resolves.toEqual({
      mode: 'call',
      session: {
        call_id: callBody.call_id,
        session_id: callBody.session_id,
        livekit: callBody.livekit,
        expires_at: callBody.expires_at,
      },
    });
    const insecure = client(() =>
      Promise.resolve(
        json(200, { ...callBody, livekit: { ...callBody.livekit, url: 'ws://media.example.com' } }),
      ),
    );
    await expect(insecure.api.answerInvite('inv_abcdefghijklmnopqrstuvwxyz')).rejects.toMatchObject(
      { kind: 'invalid_response' },
    );
  });
  it('uploads, removes and locates agent photos with authorization', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createTwringApi({
      baseUrl: 'https://api.cord.invalid',
      auth: {
        token: () => 'secret',
        refresh: () => Promise.resolve('secret'),
        expired: () => undefined,
      },
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(
          url === 'file:///photo.jpg'
            ? new Response(new Blob(['jpeg']))
            : json(200, { ...AGENT, avatar_version: 4 }),
        );
      },
    });
    expect(await api.agentAvatarUrl(AGENT.id)).toEqual({
      uri: `https://api.cord.invalid/v1/agents/${AGENT.id}/avatar`,
      headers: { authorization: 'Bearer secret' },
    });
    expect((await api.setAgentAvatar(AGENT.id, 'file:///photo.jpg')).avatar_version).toBe(4);
    expect(calls[1]?.init).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', authorization: 'Bearer secret' },
    });
    expect(calls[1]?.init.body).toBeInstanceOf(Blob);
    await api.removeAgentAvatar(AGENT.id);
    expect(calls[2]?.init.method).toBe('DELETE');
  });

  it('posts validated call feedback and checks the response', async () => {
    const { api, calls } = client(() => Promise.resolve(json(200, { ok: true })));
    await api.sendCallFeedback('call_abcdefghij0123456789', {
      rating: 2,
      issues: ['slow'],
      note: ' late ',
    });
    expect(calls[0]?.url).toBe(
      'https://api.cord.invalid/v1/calls/call_abcdefghij0123456789/feedback',
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ rating: 2, issues: ['slow'], note: 'late' }));
  });

  it('sends the app version with each request, so feedback says which build it came from', async () => {
    const calls: { init: RequestInit }[] = [];
    const api = createTwringApi({
      baseUrl: 'https://api.cord.invalid',
      appVersion: '0.1.0 (12) ios',
      fetch: (_url, init) => {
        calls.push({ init: init ?? {} });
        return Promise.resolve(json(200, { ok: true }));
      },
    });
    await api.sendAppFeedback('hi');
    expect((calls[0]?.init.headers as Record<string, string>)['x-app-version']).toBe(
      '0.1.0 (12) ios',
    );
  });

  it('posts a note from Settings and checks the response', async () => {
    const { api, calls } = client(() => Promise.resolve(json(200, { ok: true })));
    await api.sendAppFeedback(' Love it ');
    expect(calls[0]?.url).toBe('https://api.cord.invalid/v1/me/feedback');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ note: 'Love it' }));
  });

  it('starts a new conversation and validates the acknowledgement', async () => {
    const { api, calls } = client(() => Promise.resolve(json(200, { ok: true })));
    await expect(api.newConversation(AGENT.id)).resolves.toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`https://api.cord.invalid/v1/agents/${AGENT.id}/new-conversation`);
    expect(calls[0]?.init.method).toBe('POST');
    const invalid = client(() => Promise.resolve(json(200, { ok: false })));
    await expect(invalid.api.newConversation(AGENT.id)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });
  it('reads access and treats a missing gate as membership', async () => {
    const { api, calls } = client(() =>
      Promise.resolve(json(200, { member: false, email: 'a@b.test' })),
    );
    expect(await api.getAccess!()).toEqual({ member: false, email: 'a@b.test' });
    expect(calls[0]?.url).toBe('https://api.cord.invalid/v1/me/access');
    const missing = client(() =>
      Promise.resolve(json(404, { error: { code: 'not_found', message: 'missing' } })),
    );
    expect(await missing.api.getAccess!()).toEqual({ member: true });
  });

  it('redeems an invite and exposes an invalid code as ApiError', async () => {
    const { api, calls } = client(() =>
      Promise.resolve(json(200, { member: true, email: 'a@b.test' })),
    );
    expect(await api.redeemInvite!('123456')).toEqual({ member: true, email: 'a@b.test' });
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://api.cord.invalid/v1/me/invite');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ code: '123456' });
    const invalid = client(() =>
      Promise.resolve(json(400, { error: { code: 'invite_invalid', message: 'bad' } })),
    );
    await expect(invalid.api.redeemInvite!('000000')).rejects.toEqual(
      new ApiError('http', 'invite_invalid', undefined, undefined, 400),
    );
  });

  it('builds an authenticated message speech source', async () => {
    const api = createTwringApi({
      baseUrl: 'https://api.cord.invalid/',
      auth: {
        token: () => 'token',
        refresh: () => Promise.resolve(undefined),
        expired: () => undefined,
      },
    });
    expect(await api.messageSpeechUrl('agt_a/b', 'msg_c d')).toEqual({
      uri: 'https://api.cord.invalid/v1/agents/agt_a%2Fb/messages/msg_c%20d/speech',
      headers: { authorization: 'Bearer token' },
    });
  });

  it('uploads a voice note as an audio/mp4 Blob, since Android ignores the header for Blobs', async () => {
    const { api, calls } = client((url) =>
      Promise.resolve(
        url.startsWith('file:')
          ? new Response(new Blob([new Uint8Array([1, 2, 3])]))
          : json(500, { error: { code: 'internal', message: 'x', request_id: 'r' } }),
      ),
    );
    await api.sendVoiceNote(AGENT.id, 'c-1', 5000, 'file:///note.m4a').catch(() => undefined);
    const upload = calls.find((call) => call.url.includes('/voice-notes?'));
    expect(upload?.init.body).toBeInstanceOf(Blob);
    expect((upload?.init.body as Blob).type).toBe('audio/mp4');
    expect((upload?.init.body as Blob).size).toBe(3);
  });

  it('uploads a typed file Blob with its stable id and sends ordered attachment ids', async () => {
    const file = {
      id: 'fil_aaaaaaaaaaaaaaaaaaaa',
      name: 'report.pdf',
      mime_type: 'application/pdf',
      size_bytes: 3,
    };
    const sent = {
      id: 'msg_aaaaaaaaaaaaaaaaaaaa',
      agent_id: AGENT.id,
      seq: 1,
      rev: 1,
      kind: 'user_text',
      text: '',
      status: 'sent',
      client_id: '7c5b0190-85e7-4c9c-8d1a-474a35a71df1',
      attachments: [file],
      created_at: '2026-10-13T00:00:00.000Z',
      updated_at: '2026-10-13T00:00:00.000Z',
    };
    const { api, calls, timers } = client((url) =>
      Promise.resolve(
        url.startsWith('file:')
          ? new Response(new Blob([new Uint8Array([1, 2, 3])]))
          : json(200, url.includes('/files?') ? { file } : { message: sent }),
      ),
    );
    const result = await api.uploadFile?.(AGENT.id, {
      clientId: sent.client_id,
      uri: 'file:///report.pdf',
      name: 'report.pdf',
      mimeType: 'application/pdf',
    });
    expect(result).toEqual(file);
    const upload = calls.find((call) => call.url.includes('/files?'))!;
    expect(upload.url).toContain(`client_id=${sent.client_id}&name=report.pdf`);
    expect((upload.init.body as Blob).type).toBe('application/pdf');
    expect((upload.init.body as Blob).size).toBe(3);
    expect(upload.init.headers).toMatchObject({ 'content-type': 'application/pdf' });
    expect(timers.delays).toContain(60_000);
    await api.sendMessage(AGENT.id, {
      clientId: sent.client_id,
      text: '',
      attachmentIds: [file.id],
    });
    expect(JSON.parse(calls.at(-1)!.init.body as string)).toEqual({
      client_id: sent.client_id,
      text: '',
      attachment_ids: [file.id],
    });
  });

  it('posts a chat approval and carries the current message on conflict', async () => {
    const message = {
      id: 'msg_aaaaaaaaaaaaaaaaaaaa',
      agent_id: AGENT.id,
      seq: 1,
      rev: 2,
      kind: 'approval',
      approval_id: 'apr-1',
      title: 'Run report',
      status: 'allowed',
      expires_at: AGENT.updated_at,
      created_at: AGENT.created_at,
      updated_at: AGENT.updated_at,
    };
    const success = client(() => Promise.resolve(json(200, { message })));
    await expect(success.api.decideChatApproval(AGENT.id, message.id, 'approve')).resolves.toEqual(
      message,
    );
    expect(success.calls[0]?.url).toContain(`/approvals/${message.id}`);
    expect(success.calls[0]?.init.body).toBe('{"decision":"approve"}');
    const conflict = client(() =>
      Promise.resolve(
        json(409, {
          error: { code: 'approval_already_decided', message: 'Decided', request_id: 'req-1' },
          message,
        }),
      ),
    );
    await expect(
      conflict.api.decideChatApproval(AGENT.id, message.id, 'deny'),
    ).rejects.toMatchObject({ status: 409, currentMessage: message });
  });
  it('uses thread routes, query cursors, and validates response envelopes', async () => {
    const message = {
      id: 'msg_aaaaaaaaaaaaaaaaaaaa',
      agent_id: AGENT.id,
      seq: 1,
      rev: 2,
      kind: 'user_text',
      text: 'hi',
      status: 'sent',
      client_id: '123e4567-e89b-42d3-a456-426614174000',
      created_at: AGENT.created_at,
      updated_at: AGENT.updated_at,
    };
    const { api, calls } = client((_url, init) =>
      Promise.resolve(
        json(
          init.method === 'POST' ? 201 : 200,
          init.method === 'GET' && calls.length === 1
            ? { threads: [] }
            : init.method === 'GET'
              ? { messages: [message], has_more: false }
              : init.method === 'DELETE'
                ? { deleted: 1 }
                : { message },
        ),
      ),
    );
    await expect(api.listThreads()).resolves.toEqual({ threads: [], files: false });
    await expect(api.listMessages(AGENT.id, { afterRev: 2, limit: 50 })).resolves.toEqual({
      messages: [message],
      hasMore: false,
    });
    await expect(
      api.sendMessage(AGENT.id, { clientId: message.client_id, text: 'hi' }),
    ).resolves.toEqual(message);
    await expect(api.stopMessage(AGENT.id, message.id)).resolves.toEqual(message);
    await expect(api.clearChat(AGENT.id)).resolves.toEqual({ deleted: 1 });
    expect(calls[1]?.url).toContain('after_rev=2&limit=50');
    expect(calls[2]?.init.body).toBe(JSON.stringify({ client_id: message.client_id, text: 'hi' }));
    expect(calls[3]?.url).toContain(`/messages/${message.id}/stop`);
  });

  it('writes the read marker with an empty 204 response', async () => {
    const { api, calls } = client(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(api.markRead(AGENT.id, 12)).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe(`https://api.cord.invalid/v1/agents/${AGENT.id}/read`);
    expect(calls[0]?.init.body).toBe('{"seq":12}');
  });
  it('parses the agent list', async () => {
    const { api, calls } = client(() => Promise.resolve(json(200, { agents: [AGENT] })));
    await expect(api.listAgents()).resolves.toEqual([AGENT]);
    expect(calls[0]?.url).toBe('https://api.cord.invalid/v1/agents');
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('rejects a malformed response', async () => {
    const { api } = client(() => Promise.resolve(json(200, { agents: [{ id: 'nope' }] })));
    await expect(api.listAgents()).rejects.toEqual(new ApiError('invalid_response'));
  });

  it('sends create and patch bodies as JSON', async () => {
    const { api, calls } = client(() => Promise.resolve(json(201, AGENT)));
    await api.createAgent({
      name: 'Operator',
      protocol: 'cord-native',
      endpoint_url: 'wss://agent.example.com/cord',
    });
    await api.updateAgent(AGENT.id, { credential: null });
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({ name: 'Operator' });
    expect(calls[1]?.url).toBe(`https://api.cord.invalid/v1/agents/${AGENT.id}`);
    expect(calls[1]?.init.body).toBe('{"credential":null}');
  });

  it('accepts an empty 204 on delete', async () => {
    const { api } = client(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(api.deleteAgent(AGENT.id)).resolves.toBeUndefined();
  });

  it('posts an approval decision and accepts 204', async () => {
    const { api, calls } = client(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(api.decideApproval('call/1', 'approval/2', 'deny')).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe('https://api.cord.invalid/v1/calls/call%2F1/approvals/approval%2F2');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"decision":"deny"}');
  });

  it('deletes my data and parses the counts', async () => {
    const counts = {
      deleted: { agents: 2, credentials: 1, call_history: 7 },
      live_calls_ended: 0,
    };
    const { api, calls } = client(() => Promise.resolve(json(200, counts)));
    await expect(api.deleteMyData()).resolves.toEqual(counts);
    expect(calls[0]).toMatchObject({
      url: 'https://api.cord.invalid/v1/me/data',
      init: { method: 'DELETE' },
    });
  });

  it('maps an error body to its code and request id, never its message', async () => {
    const { api } = client(() =>
      Promise.resolve(
        json(503, {
          error: { code: 'service_unavailable', message: 'server text', request_id: 'req-1' },
        }),
      ),
    );
    const error = await api.listAgents().catch((e: unknown) => e);
    expect(error).toEqual(new ApiError('http', 'service_unavailable', 'req-1', undefined, 503));
    const copy = apiErrorCopy(error);
    expect(copy.message).not.toContain('server text');
    expect(copy.message).not.toContain('service_unavailable');
    expect(copy.detail).toBe('service_unavailable · ref req-1');
  });

  it('reports a network failure', async () => {
    const { api } = client(() => Promise.reject(new TypeError('Network request failed')));
    await expect(api.listVoices()).rejects.toEqual(new ApiError('network'));
  });

  it('times out on its own deadline, with a longer one for the connection test', async () => {
    const { api, timers } = client(hanging);
    const listing = api.listAgents();
    const testing = api.testAgent(AGENT.id);
    expect(timers.delays).toEqual([15_000, 30_000]);
    timers.fire();
    await expect(listing).rejects.toEqual(new ApiError('timeout'));
    await expect(testing).rejects.toEqual(new ApiError('timeout'));
  });

  it('tells a caller cancel apart from a timeout', async () => {
    const { api } = client(hanging);
    const controller = new AbortController();
    const pending = api.getAgent(AGENT.id, controller.signal);
    controller.abort();
    await expect(pending).rejects.toEqual(new ApiError('cancelled'));
    await expect(api.getAgent(AGENT.id, controller.signal)).rejects.toEqual(
      new ApiError('cancelled'),
    );
  });
});

describe('api error copy', () => {
  it.each([
    ['rate_limited', 'Wait a minute'],
    ['endpoint_rejected', 'https://'],
    ['credential_unreadable', 'Enter it again'],
    ['not_found', 'no longer exists'],
    ['internal_error', 'Try again in a moment'],
    ['agent_tests_disabled', 'test it again later'],
    ['voice_samples_disabled', 'still choose a voice'],
    ['daily_limit_reached', "today's calling time"],
    ['service_busy', 'very busy today'],
    ['pairing_invalid', 'Get a new code'],
    ['connector_invalid', 'Pair it again'],
  ] as const)('%s says what to do next', (code, phrase) => {
    const copy = apiErrorCopy(new ApiError('http', code));
    expect(copy.message).toContain(phrase);
    expect(copy.message).not.toContain(code);
  });

  it('every error code has copy that never shows the raw code', () => {
    for (const code of errorCodeSchema.options) {
      const copy = apiErrorCopy(new ApiError('http', code));
      expect(copy.message.length, code).toBeGreaterThan(10);
      expect(copy.message, code).not.toContain(code);
    }
  });

  it.each([
    ['device_removed', 'This phone was removed from the server. Ask an admin for a new code.'],
    ['forbidden', 'Only an admin on this server can do that.'],
    ['last_admin', "A server needs at least one admin, so this person can't be removed."],
    [
      'audio_unreachable',
      "Call audio isn't reachable on your server. Run twring audio check on the server.",
    ],
    [
      'audio_paused',
      "Calls are paused until your server's email address is confirmed. Your admin can find the email from Twring.",
    ],
    ['audio_expired', "Twring's audio service for this server has ended. Ask your admin."],
  ] as const)('self-hosted %s has its own copy', (code, message) => {
    const copy = apiErrorCopy(new ApiError('http', code));
    expect(copy.message).toBe(message);
    expect(copy.retryable).toBe(false);
  });

  it('a call limit on the server says to try again later', () => {
    const copy = apiErrorCopy(new ApiError('http', 'audio_limit_reached'));
    expect(copy.message).toBe('This server has reached its call limit for now. Try again later.');
    expect(copy.retryable).toBe(true);
  });

  it('a Twring audio outage says to try again in a minute', () => {
    const copy = apiErrorCopy(new ApiError('http', 'audio_unavailable'));
    expect(copy.message).toBe(
      "Twring's audio service can't be reached right now. Try again in a minute.",
    );
    expect(copy.retryable).toBe(true);
  });

  it('explains how an uninvited account can join the beta', () => {
    const copy = apiErrorCopy(new ApiError('http', 'not_invited'));
    expect(copy.message).toBe(
      "This Google account isn't in the Twring beta yet. Sign in with the account your invite went to, or join the waitlist at twring.com.",
    );
    expect(copy.retryable).toBe(false);
  });

  it('carries the reset time of a daily limit into the copy', () => {
    const copy = apiErrorCopy(
      new ApiError('http', 'daily_limit_reached', 'req-1', new Date('2026-10-01T00:00:00Z')),
    );
    expect(copy.retryable).toBe(false);
    expect(copy.message).toMatch(/It resets (tomorrow )?at /);
  });

  it('carries the reset time when the whole service is busy for the day', () => {
    const copy = apiErrorCopy(
      new ApiError('http', 'service_busy', 'req-1', new Date('2026-10-01T00:00:00Z')),
    );
    expect(copy.retryable).toBe(false);
    expect(copy.message).toMatch(/^Twring is very busy today\. Try again (tomorrow )?at /);
  });

  it('covers unknown failures', () => {
    expect(apiErrorCopy(new Error('x')).message).toBe('Something went wrong. Try again.');
    expect(apiErrorCopy(new ApiError('timeout')).retryable).toBe(true);
  });
});

describe('cord api client sign-in', () => {
  it('sends the bearer token, refreshes once on auth_invalid, then signs out', async () => {
    let token = 'old';
    const expired = vi.fn();
    const seen: (string | undefined)[] = [];
    const api = createTwringApi({
      baseUrl: 'https://api.cord.invalid',
      timers: new ManualTimers(),
      auth: {
        token: () => token,
        refresh: () => {
          token = 'new';
          return Promise.resolve(token);
        },
        expired,
      },
      fetch: (_url, init) => {
        seen.push((init.headers as Record<string, string>).authorization);
        return Promise.resolve(json(401, { error: { code: 'auth_invalid', message: 'x' } }));
      },
    });
    await expect(api.listAgents()).rejects.toEqual(
      new ApiError('http', 'auth_invalid', undefined, undefined, 401),
    );
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('when the session cannot be refreshed right now, keeps the user signed in and says so', async () => {
    const expired = vi.fn();
    const api = createTwringApi({
      baseUrl: 'https://api.cord.invalid',
      timers: new ManualTimers(),
      auth: {
        token: () => 'old',
        refresh: () => Promise.reject(new Error('offline')),
        expired,
      },
      fetch: () => Promise.resolve(json(401, { error: { code: 'auth_invalid', message: 'x' } })),
    });
    const error: unknown = await api.listAgents().catch((failure: unknown) => failure);
    expect(error).toEqual(new ApiError('http', 'auth_invalid', undefined, undefined, 401));
    expect(expired).not.toHaveBeenCalled();
    // The user is still signed in on this screen: the copy must not claim otherwise, and it can be
    // retried once the connection is back.
    const copy = apiErrorCopy(error);
    expect(copy.message).not.toMatch(/signed out|Sign in again/i);
    expect(copy.retryable).toBe(true);
  });

  it('says signed out only when there was no session at all', () => {
    expect(apiErrorCopy(new ApiError('http', 'auth_required')).message).toMatch(/Sign in again/);
    expect(apiErrorCopy(new ApiError('http', 'auth_required')).retryable).toBe(false);
  });

  it('retries a refused write at most once (the gateway refuses before any handler runs)', async () => {
    let calls = 0;
    const refresh = vi.fn(() => Promise.resolve('new'));
    const api = createTwringApi({
      baseUrl: 'https://api.cord.invalid',
      timers: new ManualTimers(),
      auth: { token: () => 'old', refresh, expired: vi.fn() },
      fetch: () => {
        calls += 1;
        return Promise.resolve(json(401, { error: { code: 'auth_invalid', message: 'x' } }));
      },
    });
    await expect(api.deleteMyData()).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(2);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('lists, saves and removes speech keys', async () => {
    const added = {
      last4: '4f2a',
      added_at: '2026-10-27T10:00:00.000Z',
      verified_at: '2026-10-27T10:00:00.000Z',
    };
    const list = {
      listening: 'deepgram',
      listening_choice: false,
      providers: [
        { provider: 'deepgram', added },
        { provider: 'cartesia', added: null },
      ],
    };
    const { api, calls } = client((url, init) =>
      Promise.resolve(
        init.method === 'GET'
          ? json(200, list)
          : init.method === 'PUT'
            ? json(200, { provider: 'deepgram', added })
            : new Response(null, { status: 204 }),
      ),
    );
    expect(await api.listSpeechKeys()).toEqual(list.providers);
    await api.saveSpeechKey('deepgram', 'k'.repeat(24));
    await api.removeSpeechKey('cartesia');
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['GET', 'https://api.cord.invalid/v1/me/speech-keys'],
      ['PUT', 'https://api.cord.invalid/v1/me/speech-keys/deepgram'],
      ['DELETE', 'https://api.cord.invalid/v1/me/speech-keys/cartesia'],
    ]);
    expect(calls[1]?.init.body).toBe(JSON.stringify({ key: 'k'.repeat(24) }));
  });

  it('returns the listening choice and saves who listens', async () => {
    const at = '2026-10-27T10:00:00.000Z';
    const list = {
      providers: [
        { provider: 'deepgram', added: { last4: 'abcd', added_at: at, verified_at: at } },
        { provider: 'cartesia', added: null },
        { provider: 'xai', added: { last4: 'wxyz', added_at: at, verified_at: at } },
      ],
      listening: 'deepgram',
      listening_choice: true,
    };
    const { api, calls } = client((url, init) =>
      Promise.resolve(
        init.method === 'GET' ? json(200, list) : new Response(null, { status: 204 }),
      ),
    );
    expect(await api.speechKeyState()).toEqual(list);
    await api.setListeningProvider('xai');
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['GET', 'https://api.cord.invalid/v1/me/speech-keys'],
      ['PUT', 'https://api.cord.invalid/v1/me/speech-keys/listening'],
    ]);
    expect(calls[1]?.init.body).toBe(JSON.stringify({ provider: 'xai' }));
  });

  it('keeps a history row whose end reason this app does not know', async () => {
    const row = {
      call_id: 'call_' + 'a'.repeat(20),
      agent_id: 'agt_' + 'a'.repeat(20),
      agent_name: 'Ada',
      started_at: '2026-10-27T10:00:00.000Z',
      duration_s: 12,
      outcome: 'failed',
    };
    const { api } = client(() =>
      Promise.resolve(
        json(200, {
          calls: [
            { ...row, end_reason: 'future_key_refused' },
            { ...row, end_reason: 'xai_key_refused' },
          ],
        }),
      ),
    );
    const calls = await api.history();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.end_reason).toBeUndefined();
    expect(calls[1]?.end_reason).toBe('xai_key_refused');
  });

  it('carries the server message on a failed speech key save', async () => {
    const { api } = client(() =>
      Promise.resolve(
        json(422, {
          error: {
            code: 'speech_key_refused',
            message: 'Deepgram refused this key. Check it in your Deepgram account.',
            request_id: 'r',
          },
        }),
      ),
    );
    const error = await api.saveSpeechKey('deepgram', 'k'.repeat(24)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(apiErrorCopy(error).message).toBe(
      'Deepgram refused this key. Check it in your Deepgram account.',
    );
  });
});

describe("requests to a person's own server", () => {
  it('follow no redirect there, and hosted requests are unchanged', async () => {
    const inits: RequestInit[] = [];
    const fetch = (_url: string, init: RequestInit) => {
      inits.push(init);
      return Promise.resolve(json(200, { agents: [] }));
    };
    const own = createTwringApi({ baseUrl: 'https://h.example.com', fetch, rejectRedirects: true });
    await own.listAgents();
    expect(inits[0]?.redirect).toBe('error');
    const hosted = createTwringApi({ baseUrl: 'https://api.cord.invalid', fetch });
    await hosted.listAgents();
    expect(inits[1]?.redirect).toBeUndefined();
  });
});
