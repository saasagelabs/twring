import { describe, expect, it } from 'vitest';

import { createTwringApi, type TimerApi } from './client';
import { apiErrorCopy } from './errors';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const timers: TimerApi = {
  setTimeout: () => 0,
  clearTimeout: () => undefined,
};
function client(respond: (url: string, init: RequestInit) => Promise<Response>) {
  return createTwringApi({ baseUrl: 'https://api.cord.invalid/', timers, fetch: respond });
}
const at = '2026-10-27T10:00:00.000Z';
const row = {
  call_id: 'call_' + 'a'.repeat(20),
  agent_id: 'agt_' + 'a'.repeat(20),
  agent_name: 'Ada',
  started_at: at,
  duration_s: 12,
  outcome: 'failed',
};

describe('old server compatibility', () => {
  const phase1Body = {
    providers: [
      { provider: 'deepgram', added: { last4: 'abcd', added_at: at, verified_at: at } },
      { provider: 'cartesia', added: null },
    ],
  };
  it('speechKeyState reads a phase 1 server list (no listening fields)', async () => {
    const api = client(() => Promise.resolve(json(200, phase1Body)));
    await expect(api.speechKeyState()).resolves.toMatchObject({ listening_choice: false });
  });
  it('listSpeechKeys (Settings row gate) reads a phase 1 server list', async () => {
    const api = client(() => Promise.resolve(json(200, phase1Body)));
    await expect(api.listSpeechKeys()).resolves.toHaveLength(2);
  });
  it('PUT listening 404 on an old server rejects (caller copy decides)', async () => {
    const api = client(() =>
      Promise.resolve(
        json(404, { error: { code: 'not_found', message: 'nope', request_id: 'r' } }),
      ),
    );
    await expect(api.setListeningProvider('xai')).rejects.toBeDefined();
  });
});

describe('tolerant history end reasons', () => {
  const hist = (calls: unknown[]) => client(() => Promise.resolve(json(200, { calls }))).history();
  it('null, number, missing end_reason keep the row', async () => {
    const calls = await hist([
      { ...row, end_reason: null },
      { ...row, end_reason: 7 },
      { ...row },
      { ...row, end_reason: 'hangup' },
    ]);
    expect(calls.map((c) => c.end_reason)).toEqual([undefined, undefined, undefined, 'hangup']);
  });
  it('still rejects genuinely malformed rows and bodies', async () => {
    await expect(hist([{ ...row, outcome: 'weird', end_reason: 'future' }])).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    await expect(hist([{ ...row, duration_s: -1 }])).rejects.toBeDefined();
    await expect(hist(['x'])).rejects.toBeDefined();
    await expect(hist([null])).rejects.toBeDefined();
    await expect(
      client(() => Promise.resolve(json(200, { calls: 'x' }))).history(),
    ).rejects.toBeDefined();
    await expect(client(() => Promise.resolve(json(200, [row]))).history()).rejects.toBeDefined();
    await expect(client(() => Promise.resolve(json(200, null))).history()).rejects.toBeDefined();
  });
  it('a missed_invite row with an unknown end reason keeps the row', async () => {
    const calls = await hist([
      { ...row, kind: 'missed_invite', call_id: 'inv_' + 'a'.repeat(26), end_reason: 'zzz' },
    ]);
    expect(calls).toHaveLength(1);
  });
});

describe('provider fallbacks', () => {
  it('no provider keeps the generic copy', async () => {
    const api = client(() =>
      Promise.resolve(
        json(400, { error: { code: 'speech_key_refused', message: '', request_id: 'r' } }),
      ),
    );
    const err = await api.saveSpeechKey('xai', 'k'.repeat(24)).catch((e: unknown) => e);
    expect(apiErrorCopy(err).message).toBe(
      'Your voice account key was refused. Update it in Settings.',
    );
    expect(apiErrorCopy(err, { provider: 'xai' }).message).toBe(
      'xAI refused this key. Check it in your xAI account.',
    );
  });
});

describe('a newer server', () => {
  const keysBody = {
    providers: [
      { provider: 'deepgram', added: null },
      { provider: 'cartesia', added: null },
      { provider: 'xai', added: null },
      { provider: 'elevenlabs', added: null },
    ],
    listening: 'deepgram',
    listening_choice: false,
  };
  it('a newer server listing a fourth provider still lets the Settings row show', async () => {
    const api = client(() => Promise.resolve(json(200, keysBody)));
    await expect(api.listSpeechKeys()).resolves.toHaveLength(3);
  });
  it('an unknown listening value reads as Deepgram with no choice', async () => {
    const api = client(() =>
      Promise.resolve(json(200, { ...keysBody, listening: 'elevenlabs', listening_choice: true })),
    );
    await expect(api.speechKeyState()).resolves.toMatchObject({
      listening: 'deepgram',
      listening_choice: false,
    });
  });
  it('still rejects malformed speech key bodies', async () => {
    const get = (body: unknown) => client(() => Promise.resolve(json(200, body))).speechKeyState();
    await expect(get({ providers: 'x' })).rejects.toBeDefined();
    await expect(get({ providers: [{ provider: 'deepgram' }] })).rejects.toBeDefined();
    await expect(get({ providers: [null] })).rejects.toBeDefined();
    await expect(get(null)).rejects.toBeDefined();
    await expect(
      get({ providers: [], listening: 'deepgram', listening_choice: 'yes' }),
    ).rejects.toBeDefined();
  });

  const AGENT = {
    id: 'agt_abcdefghij0123456789',
    name: 'Operator',
    protocol: 'cord-native',
    endpoint_url: 'wss://agent.example.com/cord',
    voice_id: 'eleven-bob-en',
    keyterms: [],
    has_credential: true,
    status: 'ready',
    created_at: at,
    updated_at: at,
  };
  it('drops an unknown voice from the offered list', async () => {
    const api = client(() =>
      Promise.resolve(
        json(200, {
          voices: [
            { id: 'flux-ada-en', label: 'Ada' },
            { id: 'eleven-bob-en', label: 'Bob' },
          ],
          default_voice_id: 'flux-ada-en',
        }),
      ),
    );
    const list = await api.listVoices();
    expect(list.voices.map((v) => v.id)).toEqual(['flux-ada-en']);
  });
  it('still rejects a malformed voice list', async () => {
    const get = (body: unknown) => client(() => Promise.resolve(json(200, body))).listVoices();
    await expect(
      get({ voices: [{ id: 'flux-ada-en' }], default_voice_id: 'flux-ada-en' }),
    ).rejects.toBeDefined();
    await expect(get({ voices: 'x', default_voice_id: 'flux-ada-en' })).rejects.toBeDefined();
  });
  it('an agent with an unknown voice id is still listed', async () => {
    const api = client(() => Promise.resolve(json(200, { agents: [AGENT] })));
    const agents = await api.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.voice_id).not.toBe('eleven-bob-en');
    const one = await client(() => Promise.resolve(json(200, AGENT))).getAgent(AGENT.id);
    expect(one.name).toBe('Operator');
    await expect(
      client(() =>
        Promise.resolve(json(200, { agents: [{ ...AGENT, voice_id: 7 }] })),
      ).listAgents(),
    ).rejects.toBeDefined();
  });
});
