import type { ThreadMessage } from '@twring/contracts';
import { loadGatewayEnv } from '@twring/config/gateway';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import { StoreCorruptError } from '../store/collection';
import { SpeechKeyUnreadableError, type SpeechResolver } from '../voice/speech-resolver';
import { registerMessageSpeechRoute, type MessageSpeechOptions } from './speech';

const agentId = `agt_${'a'.repeat(20)}`;
const messageId = `msg_${'b'.repeat(20)}`;
const url = `/v1/agents/${agentId}/messages/${messageId}/speech`;

function setup({
  voice = 'cartesia-janvi-en',
  text = 'Hello there.',
  kind = 'agent_text',
  owner = 'alice',
  fetcher = vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))),
}: {
  voice?: string;
  text?: string;
  kind?: string;
  owner?: string;
  fetcher?: typeof fetch;
} = {}) {
  const app = Fastify();
  const options: MessageSpeechOptions = {
    agents: {
      get: (user) => Promise.resolve(user === owner ? ({ voice_id: voice } as never) : undefined),
    },
    store: {
      findMessageById: (user) =>
        Promise.resolve(user === owner ? ({ kind, text } as ThreadMessage) : undefined),
    },
    deepgram: { apiKey: 'deepgram-key' },
    cartesia: { apiKey: 'cartesia-key', ttsModel: 'sonic-3' },
    userFor: (request) => String(request.headers['x-user'] ?? 'alice'),
    fetch: fetcher,
  };
  registerMessageSpeechRoute(app, options);
  return { app, fetcher };
}

describe('message speech route', () => {
  it('uses the agent Cartesia voice and caches the audio', async () => {
    const { app, fetcher } = setup();
    const first = await app.inject({ method: 'GET', url });
    const second = await app.inject({ method: 'GET', url });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('audio/mpeg');
    expect(first.headers['cache-control']).toBe('private, max-age=600');
    expect(second.statusCode).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [target, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(target).toBe('https://api.cartesia.ai/tts/bytes');
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model_id: 'sonic-3',
      voice: { mode: 'id', id: '7ea5e9c2-b719-4dc3-b870-5ba5f14d31d8' },
    });
    await app.close();
  });

  it('uses Deepgram and cuts long cleaned text at a sentence', async () => {
    const { app, fetcher } = setup({
      voice: 'flux-haley-en',
      text: `Intro. ${'Long words '.repeat(400)}`,
    });
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    const [target, init] = vi.mocked(fetcher).mock.calls[0]!;
    // Flux voices are served only by /v2/speak; /v1/speak rejects them with a 400.
    expect(target).toBe('https://api.deepgram.com/v2/speak?model=flux-haley-en&encoding=mp3');
    const body = JSON.parse(init?.body as string) as { text: string };
    expect(body.text).toBe('Intro. The rest is in the chat.');
    await app.close();
  });

  it('hides non-agent and other-user messages', async () => {
    const { app } = setup({ kind: 'user_text' });
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url, headers: { 'x-user': 'bob' } })).statusCode,
    ).toBe(404);
    await app.close();
  });

  it('falls back to the other provider when the agent voice fails', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5]), { status: 200 }));
    const { app } = setup({ fetcher });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(fetcher.mock.calls.map(([target]) => target)).toEqual([
      'https://api.cartesia.ai/tts/bytes',
      'https://api.deepgram.com/v2/speak?model=flux-haley-en&encoding=mp3',
    ]);
    await app.close();
  });

  it('returns 502 when both providers fail or time out', async () => {
    const failed = setup({
      fetcher: vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    });
    expect((await failed.app.inject({ method: 'GET', url })).statusCode).toBe(502);
    expect(failed.fetcher).toHaveBeenCalledTimes(2);
    await failed.app.close();
    vi.useFakeTimers();
    try {
      const timed = setup({ fetcher: vi.fn(() => new Promise<Response>(() => undefined)) });
      const pending = timed.app.inject({ method: 'GET', url });
      await vi.advanceTimersByTimeAsync(40_000);
      expect((await pending).statusCode).toBe(502);
      await timed.app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('limits a user to 20 requests a minute', async () => {
    const { app } = setup();
    for (let i = 0; i < 20; i++)
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(429);
    await app.close();
  });

  it('is absent when chats are off', async () => {
    const app = buildApp({ env: loadGatewayEnv(gatewayEnvFixture()), userFor: () => 'alice' });
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    await app.close();
  });
});

describe('message speech with a person’s own keys', () => {
  function ownSetup(resolve: SpeechResolver['resolve'], fetcher: typeof fetch) {
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: 'debug', stream: { write: (line: string) => lines.push(line) } },
    });
    const onError = vi.fn();
    registerMessageSpeechRoute(app, {
      agents: { get: () => Promise.resolve({ voice_id: 'cartesia-janvi-en' } as never) },
      store: {
        findMessageById: () =>
          Promise.resolve({ kind: 'agent_text', text: 'Hello there.' } as ThreadMessage),
      },
      deepgram: { apiKey: 'deepgram-key' },
      cartesia: { apiKey: 'cartesia-key', ttsModel: 'sonic-3' },
      userFor: () => 'alice',
      fetch: fetcher,
      speech: { resolve },
      onError,
    });
    return { app, lines, onError };
  }
  const own = () =>
    Promise.resolve({
      deepgram: { apiKey: 'deepgram-key', source: 'twring' as const },
      cartesia: { apiKey: 'own-cartesia-secret', source: 'own' as const },
    });

  it('speaks with the own key and caches the audio as before', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(new Uint8Array([1, 2]), { status: 200 })),
    );
    const { app } = ownSetup(own, fetcher);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: 'Bearer own-cartesia-secret',
    });
    await app.close();
  });

  it.each([401, 402, 403])(
    'a refused own key (%i) gives 409 with no backup voice',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status })));
      const { app, lines } = ownSetup(own, fetcher);
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: {
          code: 'speech_key_refused',
          message: 'Your Cartesia key was refused. Update it in Settings.',
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(lines.join('\n')).not.toContain('own-cartesia-secret');
      await app.close();
    },
  );

  it('an unreadable saved key gives 409; an unreadable store gives 503 and alerts', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const unreadable = ownSetup(
      () => Promise.reject(new SpeechKeyUnreadableError('cartesia')),
      fetcher,
    );
    const res = await unreadable.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: 'speech_key_unreadable',
        message: "Couldn't read your saved Cartesia key. Add it again in Settings.",
      },
    });
    await unreadable.app.close();
    const corrupt = ownSetup(
      () => Promise.reject(new StoreCorruptError('speech-keys.json')),
      fetcher,
    );
    const down = await corrupt.app.inject({ method: 'GET', url });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({
      error: { message: 'Voice is briefly unavailable. Try again in a moment.' },
    });
    expect(corrupt.onError).toHaveBeenCalledTimes(1);
    expect(corrupt.lines.some((line) => line.includes('speech_keys_unavailable'))).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    await corrupt.app.close();
  });

  it('a refused Twring key still falls back to the other voice', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4]), { status: 200 }));
    const { app } = ownSetup(
      () =>
        Promise.resolve({
          deepgram: { apiKey: 'deepgram-key', source: 'twring' as const },
          cartesia: { apiKey: 'cartesia-key', source: 'twring' as const },
        }),
      fetcher,
    );
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await app.close();
  });
});

describe('message speech: an own key never falls back', () => {
  it.each([
    ['cartesia-janvi-en', 500],
    ['cartesia-janvi-en', 429],
    ['flux-haley-en', 500],
  ])('own key for %s failing with %i answers 502 with no second request', async (voice, status) => {
    const app = Fastify();
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status })));
    registerMessageSpeechRoute(app, {
      agents: { get: () => Promise.resolve({ voice_id: voice } as never) },
      store: {
        findMessageById: () =>
          Promise.resolve({ kind: 'agent_text', text: 'Hello there.' } as ThreadMessage),
      },
      deepgram: { apiKey: 'deepgram-key' },
      cartesia: { apiKey: 'cartesia-key', ttsModel: 'sonic-3' },
      userFor: () => 'alice',
      fetch: fetcher,
      speech: {
        resolve: () =>
          Promise.resolve({
            deepgram: { apiKey: 'own-dg', source: 'own' as const },
            cartesia: { apiKey: 'own-ct', source: 'own' as const },
          }),
      },
    });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { message: 'Could not play this reply.' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('message speech on a Grok voice', () => {
  function grokSetup(
    resolved: Awaited<ReturnType<SpeechResolver['resolve']>>,
    fetcher: typeof fetch,
  ) {
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: 'debug', stream: { write: (line: string) => lines.push(line) } },
    });
    registerMessageSpeechRoute(app, {
      agents: { get: () => Promise.resolve({ voice_id: 'xai-eve-en' } as never) },
      store: {
        findMessageById: () =>
          Promise.resolve({ kind: 'agent_text', text: 'Hello there.' } as ThreadMessage),
      },
      deepgram: { apiKey: 'deepgram-key' },
      cartesia: { apiKey: 'cartesia-key', ttsModel: 'sonic-3' },
      userFor: () => 'alice',
      fetch: fetcher,
      speech: { resolve: () => Promise.resolve(resolved) },
    });
    return { app, lines };
  }
  const withXai = {
    deepgram: { apiKey: 'deepgram-key', source: 'twring' as const },
    cartesia: { apiKey: 'cartesia-key', source: 'twring' as const },
    xai: { apiKey: 'own-xai-secret', source: 'own' as const },
  };

  it('speaks with the own xAI key on the Grok voice', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(new Uint8Array([7, 8]), { status: 200 })),
    );
    const { app } = grokSetup(withXai, fetcher);
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0] as string).toBe('https://api.x.ai/v1/tts');
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: 'Bearer own-xai-secret',
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1]?.body as string)).toMatchObject({
      voice_id: 'eve',
    });
    await app.close();
  });

  it.each([401, 402, 403])(
    'a refused xAI key (%i) gives 409 naming xAI, no backup',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status })));
      const { app, lines } = grokSetup(withXai, fetcher);
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: {
          code: 'speech_key_refused',
          message: 'Your xAI key was refused. Update it in Settings.',
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(lines.join('\n')).not.toContain('own-xai-secret');
      expect(res.body).not.toContain('own-xai-secret');
      await app.close();
    },
  );

  it.each([500, 429])(
    'another xAI failure (%i) gives 502 with no backup request',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status })));
      const { app } = grokSetup(withXai, fetcher);
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(502);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await app.close();
    },
  );

  it("without an xAI key speaks Twring's default voice and never calls xAI", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(new Uint8Array([1]), { status: 200 })),
    );
    const { app } = grokSetup({ deepgram: withXai.deepgram, cartesia: withXai.cartesia }, fetcher);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0] as string).toBe('https://api.cartesia.ai/tts/bytes');
    await app.close();
  });

  it('without an xAI key or Cartesia speaks the Deepgram default', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(new Uint8Array([1]), { status: 200 })),
    );
    const { app } = grokSetup({ deepgram: withXai.deepgram }, fetcher);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0] as string).toContain(
      'api.deepgram.com/v2/speak?model=flux-haley-en',
    );
    await app.close();
  });
});

describe('message speech on a self-hosted server with only its own xAI key', () => {
  function xaiServer(voice: string, resolved: Awaited<ReturnType<SpeechResolver['resolve']>>) {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(new Uint8Array([7, 8]), { status: 200 })),
    );
    const app = Fastify();
    registerMessageSpeechRoute(app, {
      agents: { get: () => Promise.resolve({ voice_id: voice } as never) },
      store: {
        findMessageById: () =>
          Promise.resolve({ kind: 'agent_text', text: 'Hello there.' } as ThreadMessage),
      },
      userFor: () => 'alice',
      fetch: fetcher,
      speech: { resolve: () => Promise.resolve(resolved) },
    });
    return { app, fetcher };
  }
  const server = {
    xai: { apiKey: 'server-xai-key', source: 'twring' as const },
    listening: 'xai' as const,
  };
  const sent = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => ({
    url: fetcher.mock.calls[0]![0] as string,
    auth: (fetcher.mock.calls[0]![1]?.headers as Record<string, string>).Authorization,
    voice: (JSON.parse(fetcher.mock.calls[0]![1]?.body as string) as { voice_id: string }).voice_id,
  });

  it('speaks a Grok voice on the server xAI key', async () => {
    const { app, fetcher } = xaiServer('xai-rex-en', server);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(sent(fetcher)).toEqual({
      url: 'https://api.x.ai/v1/tts',
      auth: 'Bearer server-xai-key',
      voice: 'rex',
    });
    await app.close();
  });

  it('a voice the server cannot speak falls back to the server Grok voice', async () => {
    for (const voice of ['flux-haley-en', 'cartesia-janvi-en']) {
      const { app, fetcher } = xaiServer(voice, server);
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(sent(fetcher)).toEqual({
        url: 'https://api.x.ai/v1/tts',
        auth: 'Bearer server-xai-key',
        voice: 'eve',
      });
      await app.close();
    }
  });

  it('the person’s own Deepgram key still speaks their Deepgram voice', async () => {
    const { app, fetcher } = xaiServer('flux-haley-en', {
      ...server,
      deepgram: { apiKey: 'own-dg-secret', source: 'own' },
    });
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(fetcher.mock.calls[0]![0] as string).toContain('api.deepgram.com/v2/speak');
    await app.close();
  });

  it('a refused server key is not blamed on the person', async () => {
    const { app, fetcher } = xaiServer('xai-eve-en', server);
    fetcher.mockImplementation(() => Promise.resolve(new Response(null, { status: 401 })));
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: 'service_unavailable' } });
    await app.close();
  });
});
