import { describe, expect, it, vi } from 'vitest';

import type { ServerProfile } from './profiles';
import { answerWhenReady, serverReady } from './ready';

const selfhost: ServerProfile = {
  kind: 'selfhost',
  serverId: 'srv_1',
  address: 'https://home.example.com',
  name: 'Home',
  publicKey: 'pk',
  person: { id: 'person-1', displayName: 'Sam', role: 'admin' },
  deviceId: 'pd_1',
  audio: 'own',
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('serverReady', () => {
  it('hosted resolves at once with no start or check', async () => {
    const start = vi.fn(() => Promise.resolve());
    const check = vi.fn(() => Promise.resolve());
    await serverReady({ active: () => ({ kind: 'hosted' }), start, check });
    expect(start).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it('self-hosted starts, then waits for the identity check', async () => {
    let release: () => void = () => undefined;
    const check = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    let done = false;
    const ready = serverReady({ active: () => selfhost, start: () => Promise.resolve(), check });
    void ready.then(() => (done = true));
    await tick();
    expect(check).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    release();
    await ready;
    expect(done).toBe(true);
  });
});

describe('answerWhenReady', () => {
  it('a hosted answer runs with no wait', () => {
    const answer = vi.fn(() => Promise.resolve());
    const ready = vi.fn(() => new Promise<void>(() => undefined));
    void answerWhenReady({ active: () => ({ kind: 'hosted' }), ready }, answer);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
  });

  it('a rejecting start or check still lets the answer run', async () => {
    const answer = vi.fn(() => Promise.resolve());
    await answerWhenReady(
      {
        active: () => selfhost,
        ready: () =>
          serverReady({
            active: () => selfhost,
            start: () => Promise.reject(new Error('storage')),
            check: () => Promise.resolve(),
          }),
      },
      answer,
    );
    await answerWhenReady(
      {
        active: () => selfhost,
        ready: () =>
          serverReady({
            active: () => selfhost,
            start: () => Promise.resolve(),
            check: () => Promise.reject(new Error('offline')),
          }),
      },
      answer,
    );
    expect(answer).toHaveBeenCalledTimes(2);
  });

  it('an answer before the check sends no request with a token, and goes on after it', async () => {
    let token: string | undefined;
    let release: () => void = () => undefined;
    const sent: (string | undefined)[] = [];
    const work = answerWhenReady(
      {
        active: () => selfhost,
        ready: () =>
          serverReady({
            active: () => selfhost,
            start: () => Promise.resolve(),
            check: () =>
              new Promise<void>((resolve) => {
                release = () => {
                  token = 'device-token';
                  resolve();
                };
              }),
          }),
      },
      () => {
        sent.push(token);
        return Promise.resolve();
      },
    );
    await tick();
    expect(sent).toEqual([]);
    release();
    await work;
    expect(sent).toEqual(['device-token']);
  });
});
