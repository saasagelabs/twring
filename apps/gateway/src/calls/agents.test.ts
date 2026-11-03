import {
  AdapterError,
  FakeAgentAdapter,
  NativeWsAdapter,
  RepeatAgentAdapter,
  RestSseAdapter,
} from '@twring/agent-adapter';
import { describe, expect, it } from 'vitest';

import { agentFactoryFor, nativeAgentFactory, openAiChatFactory, restAgentFactory } from './agents';

const NATIVE = {
  CORD_ENV: 'development',
  AGENT_NATIVE_URL: 'ws://127.0.0.1:8787',
  AGENT_NATIVE_TOKEN: 'dev-token',
  AGENT_REST_URL: 'http://127.0.0.1:8789/cord/turns',
  AGENT_REST_TOKEN: 'dev-token',
} as const;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('agentFactoryFor', () => {
  it('picks the built-in agents, the native or REST agent, or none', async () => {
    const make = (mode: 'agent' | 'repeat' | 'native' | 'rest' | 'echo' | 'tone' | 'off') =>
      agentFactoryFor({ ...NATIVE, GATEWAY_AUDIO_TEST_MODE: mode });
    expect(await make('agent')!('call_1')).toBeInstanceOf(FakeAgentAdapter);
    expect(await make('repeat')!('call_1')).toBeInstanceOf(RepeatAgentAdapter);
    const native = await make('native')!('call_1');
    expect(native).toBeInstanceOf(NativeWsAdapter);
    await native.close();
    expect(await make('rest')!('call_1')).toBeInstanceOf(RestSseAdapter);
    for (const mode of ['echo', 'tone', 'off'] as const) expect(make(mode)).toBeUndefined();
  });
});

describe('nativeAgentFactory', () => {
  it('rejects a private endpoint outside development with a code, never the URL', async () => {
    const create = nativeAgentFactory({
      url: 'wss://agent.internal.example/ws',
      token: 'secret-token-value-123',
      env: 'staging',
      lookup: () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]),
    });
    const error = await rejection(create('call_1'));
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe('endpoint_rejected');
    expect(String(error)).not.toContain('agent.internal.example');
    expect(String(error)).not.toContain('secret-token-value-123');
  });

  it('refuses plain ws:// outside development', async () => {
    const create = nativeAgentFactory({ url: 'ws://8.8.8.8/ws', token: 't', env: 'production' });
    expect(((await rejection(create('call_1'))) as AdapterError).code).toBe('endpoint_rejected');
  });
});

describe('restAgentFactory', () => {
  it('rejects a private endpoint or plain http outside development, never echoing the URL', async () => {
    const privateHost = restAgentFactory({
      url: 'https://agent.internal.example/cord/turns',
      token: 'secret-token-value-123',
      env: 'staging',
      lookup: () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]),
    });
    const error = await rejection(privateHost('call_1'));
    expect((error as AdapterError).code).toBe('endpoint_rejected');
    expect(String(error)).not.toContain('agent.internal.example');
    const plain = restAgentFactory({ url: 'http://8.8.8.8/x', token: 't', env: 'production' });
    expect(((await rejection(plain('call_1'))) as AdapterError).code).toBe('endpoint_rejected');
  });
});

describe('openAiChatFactory', () => {
  it('blocks a private address under production policy', async () => {
    const create = openAiChatFactory({
      url: 'https://agent.internal.example/v1',
      sessionKey: 'twring-1234',
      env: 'production',
      lookup: () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]),
    });
    expect(((await rejection(create('call_1'))) as AdapterError).code).toBe('endpoint_rejected');
  });
});
