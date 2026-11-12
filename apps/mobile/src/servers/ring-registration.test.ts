import { userRef } from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PUSH_REFRESH_MS,
  REGISTER_RETRY_MS,
  type PushRegistrationDeps,
} from '../ring/push-registration';
import type { RegisterDeviceRequest } from '../ring/protocol';
import type { SelfhostProfile, ServerProfile } from './profiles';
import {
  createRingRegistration,
  SELFHOST_REFRESH_MS,
  selfhostRegistrationDeps,
  type SelfhostRegistrationDeps,
} from './ring-registration';

const SERVER = 'https://home.example.com';
const RELAY = 'https://relay.twring.com';
const FCM = 'fcm_token_aaaaaaaaaaaaaaaaaaaaaaaa';
const VOIP = 'ab'.repeat(32);
const APNS = 'cd'.repeat(32);
const DEVICE_TOKEN = 'device-token-secret';

const profile: SelfhostProfile = {
  kind: 'selfhost',
  serverId: 'srv_1',
  address: SERVER,
  name: 'Home',
  publicKey: 'pk',
  person: { id: 'person-1', displayName: 'Sam', role: 'admin' },
  deviceId: 'pd_1',
  audio: 'own',
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: Call) => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const empty = (status: number) => new Response(null, { status });

/** A fake network: server and relay answers by route, every request recorded. */
function network(overrides: Partial<Record<string, Responder[]>> = {}) {
  const calls: Call[] = [];
  let tickets = 0;
  let handles = 0;
  const defaults: Record<string, Responder> = {
    [`POST ${SERVER}/v1/me/paired-devices/current/ticket`]: () =>
      json(200, { ticket: `ticket-${++tickets}`, relay_url: RELAY }),
    [`POST ${RELAY}/v1/devices`]: () => json(201, { handle: `handle-${++handles}` }),
    [`PUT ${SERVER}/v1/me/paired-devices/current/relay`]: () => empty(204),
    [`DELETE ${SERVER}/v1/me/paired-devices/current/relay`]: () => empty(204),
  };
  const queues = new Map(Object.entries(overrides).map(([k, v]) => [k, [...(v ?? [])]]));
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${url}`;
    const queued = queues.get(key)?.shift();
    const responder = queued ?? defaults[key];
    if (responder === undefined) throw new Error(`unexpected ${key}`);
    return responder(call);
  });
  return { calls, fetch };
}

function deps(net: ReturnType<typeof network>, over: Partial<SelfhostRegistrationDeps> = {}) {
  return {
    fetch: net.fetch,
    relayUrl: RELAY,
    ready: () => Promise.resolve(),
    token: () => DEVICE_TOKEN,
    ...over,
  } satisfies SelfhostRegistrationDeps;
}

const android: RegisterDeviceRequest = {
  fcm_token: FCM,
  platform: 'android',
  app_variant: 'production',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('selfhostRegistrationDeps', () => {
  it('asks the server for a ticket, registers with the relay, then gives the server the handle', async () => {
    const net = network();
    await selfhostRegistrationDeps(profile, deps(net)).register('dev_1', android);
    expect(net.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${SERVER}/v1/me/paired-devices/current/ticket`,
      `POST ${RELAY}/v1/devices`,
      `PUT ${SERVER}/v1/me/paired-devices/current/relay`,
    ]);
    expect(net.calls[1]?.body).toEqual({ ticket: 'ticket-1', platform: 'android', fcm_token: FCM });
    expect(net.calls[2]?.body).toEqual({ handle: 'handle-1' });
  });

  it('sends the device token only to the server, and the relay only the ticket and push tokens', async () => {
    const net = network();
    await selfhostRegistrationDeps(profile, deps(net)).register('dev_1', android);
    for (const call of net.calls) {
      if (call.url.startsWith(SERVER)) {
        expect(call.headers.authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
      } else {
        expect(call.headers.authorization).toBeUndefined();
        expect(JSON.stringify(call)).not.toContain(DEVICE_TOKEN);
      }
    }
  });

  it('iPhone sends the VoIP token, and the alert token when there is one', async () => {
    const net = network();
    const reg = selfhostRegistrationDeps(profile, deps(net));
    await reg.register('dev_1', {
      fcm_token: VOIP,
      platform: 'ios',
      app_variant: 'production',
      apns_token: APNS,
    });
    await reg.register('dev_1', { fcm_token: VOIP, platform: 'ios', app_variant: 'production' });
    const relay = net.calls.filter((c) => c.url.startsWith(RELAY)).map((c) => c.body);
    expect(relay).toEqual([
      { ticket: 'ticket-1', platform: 'ios', voip_token: VOIP, apns_token: APNS },
      { ticket: 'ticket-2', platform: 'ios', voip_token: VOIP },
    ]);
  });

  it('refuses a ticket naming another relay: nothing is sent to it', async () => {
    const net = network({
      [`POST ${SERVER}/v1/me/paired-devices/current/ticket`]: [
        () => json(200, { ticket: 't', relay_url: 'https://evil.example.com' }),
      ],
    });
    await expect(
      selfhostRegistrationDeps(profile, deps(net)).register('dev_1', android),
    ).rejects.toThrow();
    expect(net.calls).toHaveLength(1);
  });

  it('a taken handle gets one fresh ticket and relay registration, a second one stops', async () => {
    const taken: Responder = () =>
      json(409, { error: { code: 'relay_handle_taken', message: 'x', request_id: 'r' } });
    const once = network({ [`PUT ${SERVER}/v1/me/paired-devices/current/relay`]: [taken] });
    await selfhostRegistrationDeps(profile, deps(once)).register('dev_1', android);
    expect(once.calls.map((c) => c.method)).toEqual(['POST', 'POST', 'PUT', 'POST', 'POST', 'PUT']);
    expect(once.calls[5]?.body).toEqual({ handle: 'handle-2' });

    const twice = network({ [`PUT ${SERVER}/v1/me/paired-devices/current/relay`]: [taken, taken] });
    await expect(
      selfhostRegistrationDeps(profile, deps(twice)).register('dev_1', android),
    ).rejects.toThrow();
    expect(twice.calls).toHaveLength(6);
  });

  it('sends no token before the identity check, and goes on after it', async () => {
    let checked = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        checked = true;
        resolve();
      };
    });
    const net = network();
    const work = selfhostRegistrationDeps(
      profile,
      deps(net, { ready: () => gate, token: () => (checked ? DEVICE_TOKEN : undefined) }),
    ).register('dev_1', android);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(net.calls).toHaveLength(0);
    release();
    await work;
    expect(net.calls).toHaveLength(3);
    expect(net.calls[0]?.headers.authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
  });

  it('a stalled answer body ends the attempt after 10 s and the queue moves on', async () => {
    vi.useFakeTimers();
    const stalled = () =>
      ({ ok: true, status: 200, json: () => new Promise(() => undefined) }) as unknown as Response;
    const net = network({ [`POST ${SERVER}/v1/me/paired-devices/current/ticket`]: [stalled] });
    const reg = selfhostRegistrationDeps(profile, deps(net));
    const first = reg.register('dev_1', android).then(
      () => 'ok',
      () => 'failed',
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(net.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBe('failed');
    await reg.register('dev_1', android);
    expect(net.calls).toHaveLength(4);
  });

  it('follows no redirect with the device token', async () => {
    const net = network();
    const reg = selfhostRegistrationDeps(profile, deps(net));
    await reg.register('dev_1', android);
    await reg.unregister('dev_1');
    expect(net.fetch.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of net.fetch.mock.calls) expect(init?.redirect).toBe('error');
  });

  it('unregister deletes the handle on the server, and reports a failure so it is retried', async () => {
    const net = network({
      [`DELETE ${SERVER}/v1/me/paired-devices/current/relay`]: [
        () => empty(503),
        () => empty(404),
        () => empty(204),
      ],
    });
    const reg = selfhostRegistrationDeps(profile, deps(net));
    // A server that cannot remove it now: the caller keeps it pending (sign-out) or tries again
    // on the next return (notifications switched off).
    await expect(reg.unregister('dev_1')).rejects.toThrow('503');
    // Already gone counts as removed.
    await expect(reg.unregister('dev_1')).resolves.toBeUndefined();
    await expect(reg.unregister('dev_1')).resolves.toBeUndefined();
    const offline = selfhostRegistrationDeps(profile, deps(net, { token: () => undefined }));
    await offline.unregister('dev_1');
    expect(net.calls).toHaveLength(3);
    expect(net.calls.every((call) => call.method === 'DELETE')).toBe(true);
  });
});

describe('createRingRegistration', () => {
  function setup(start: ServerProfile = profile) {
    let active: ServerProfile = start;
    let now = 1_000_000;
    const net = network();
    const hosted = {
      register: vi.fn<PushRegistrationDeps['register']>().mockResolvedValue(undefined),
      unregister: vi.fn<PushRegistrationDeps['unregister']>().mockResolvedValue(undefined),
    };
    const setRingAccount = vi.fn<PushRegistrationDeps['setRingAccount']>();
    const reportSealSelfTestFailed = vi.fn();
    const sealSelfTest = vi.fn(() => Promise.resolve(false));
    const rings = createRingRegistration({
      active: () => active,
      base: {
        getToken: () => Promise.resolve(FCM),
        deviceId: () => Promise.resolve('dev_1'),
        setRingAccount,
        deleteToken: () => Promise.resolve(),
        getPendingDeviceId: () => Promise.resolve(null),
        setPendingDeviceId: () => Promise.resolve(),
        appVariant: 'production',
        platform: 'android',
        now: () => now,
      },
      hosted,
      selfhost: (p) => selfhostRegistrationDeps(p, deps(net)),
      sealSelfTest,
      reportSealSelfTestFailed,
    });
    return {
      net,
      hosted,
      rings,
      setRingAccount,
      sealSelfTest,
      reportSealSelfTestFailed,
      setActive: (p: ServerProfile) => {
        active = p;
      },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('a paired server registers right away, for the person the server rings', async () => {
    const t = setup();
    await t.rings.startForServer('srv_1');
    expect(t.net.calls).toHaveLength(3);
    expect(t.setRingAccount).toHaveBeenLastCalledWith(userRef('person-1'));
    expect(t.hosted.register).not.toHaveBeenCalled();
  });

  it('a self-hosted start registers again after 10 minutes and skips within them', async () => {
    const t = setup();
    await t.rings.signedIn('person-1');
    t.advance(SELFHOST_REFRESH_MS - 1);
    await t.rings.signedIn('person-1');
    expect(t.net.calls).toHaveLength(3);
    t.advance(1);
    await t.rings.signedIn('person-1');
    expect(t.net.calls).toHaveLength(6);
  });

  it('hosted keeps its 12 hour refresh and its own calls', async () => {
    const t = setup({ kind: 'hosted' });
    await t.rings.signedIn('user-1');
    t.advance(PUSH_REFRESH_MS - 1);
    await t.rings.signedIn('user-1');
    expect(t.hosted.register).toHaveBeenCalledTimes(1);
    t.advance(1);
    await t.rings.signedIn('user-1');
    expect(t.hosted.register).toHaveBeenCalledTimes(2);
    expect(t.net.calls).toHaveLength(0);
    expect(t.setRingAccount).toHaveBeenLastCalledWith(userRef('user-1'));
  });

  it('switching to hosted deletes the handle once and sends nothing hosted to the server', async () => {
    const t = setup();
    await t.rings.signedIn('person-1');
    // Switching runs the sign-out hooks and then stops the server's rings.
    await t.rings.current().signedOut();
    await t.rings.stopForServer('srv_1');
    t.setActive({ kind: 'hosted' });
    t.rings.activeChanged();
    await t.rings.signedIn('user-1');
    const deletes = t.net.calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(t.hosted.unregister).not.toHaveBeenCalled();
    expect(t.hosted.register).toHaveBeenCalledTimes(1);
    expect(t.net.calls).toHaveLength(4);
  });

  it('switching to a server unregisters from hosted with the hosted calls only', async () => {
    const t = setup({ kind: 'hosted' });
    await t.rings.signedIn('user-1');
    t.setActive(profile);
    t.rings.activeChanged();
    await t.rings.startForServer('srv_1');
    expect(t.hosted.unregister).toHaveBeenCalledTimes(1);
    expect(t.net.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(t.net.calls).toHaveLength(3);
  });

  it('relay 5xx and timeouts follow the usual retry delays', async () => {
    vi.useFakeTimers();
    const t = setup();
    const net = t.net;
    let failures = 2;
    net.fetch.mockImplementation(
      ((original) => async (url: string, init?: RequestInit) => {
        if (url === `${RELAY}/v1/devices` && failures > 0) {
          failures -= 1;
          net.calls.push({ url, method: 'POST', headers: {}, body: undefined });
          if (failures === 1) return empty(503);
          // The second failure is a timeout: the request is aborted.
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        return original(url, init);
      })(net.fetch.getMockImplementation()!),
    );
    await t.rings.signedIn('person-1');
    expect(net.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(REGISTER_RETRY_MS[0]);
    expect(net.calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(REGISTER_RETRY_MS[1]);
    expect(net.calls).toHaveLength(7);
  });

  it('reports a failed seal self-test once per launch', async () => {
    const t = setup();
    await t.rings.startForServer('srv_1');
    await t.rings.signedIn('person-1');
    expect(t.sealSelfTest).toHaveBeenCalledTimes(1);
    expect(t.reportSealSelfTestFailed).toHaveBeenCalledTimes(1);
  });
});
