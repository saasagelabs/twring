import {
  deviceTicketResponseSchema,
  PAIRED_DEVICE_RELAY_PATH,
  relayDeviceRequestSchema,
  relayDeviceResponseSchema,
} from '@twring/contracts';

import {
  PushRegistration,
  RegistrationStopped,
  type PushRegistrationDeps,
} from '../ring/push-registration';
import type { RegisterDeviceRequest } from '../ring/protocol';

import type { SelfhostProfile, ServerProfile } from './profiles';

/**
 * A self-hosted server re-registers this often (not the hosted 12 hours): after `twring register`
 * on a moved server every old handle is invalid, and the server cannot reach the phone to say so.
 */
export const SELFHOST_REFRESH_MS = 10 * 60_000;

const TICKET_PATH = '/v1/me/paired-devices/current/ticket';
/** Each call, answer body included. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface SelfhostRegistrationDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** The build's RELAY_URL; the only relay this phone sends push tokens to. */
  relayUrl: string;
  /** Resolves once the saved servers are read and the active one's identity check ran. */
  ready(): Promise<void>;
  /** The device token, released only after the identity check. */
  token(): string | undefined;
  timeoutMs?: number;
}

type RegistrationCalls = Pick<PushRegistrationDeps, 'register' | 'unregister'>;

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * Push registration with a paired self-hosted server: a one-time ticket from the server, the push
 * tokens to Twring's relay with that ticket (no device token, no Authorization), and the relay's
 * handle back to the server. Unregistering deletes the handle on the server.
 */
export function selfhostRegistrationDeps(
  profile: SelfhostProfile,
  deps: SelfhostRegistrationDeps,
): RegistrationCalls {
  const relay = trimSlash(deps.relayUrl);

  /** One request with its answer read in full (JSON, or undefined), all inside the timeout. */
  const send = async (
    url: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; body: unknown }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
    });
    const work = (async () => {
      const res = await deps.fetch(url, { ...init, redirect: 'error', signal: controller.signal });
      const body: unknown = await res.json().catch(() => undefined);
      return { ok: res.ok, status: res.status, body };
    })();
    work.catch(() => undefined);
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  const serverHeaders = (token: string, body: boolean): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    ...(body && { 'content-type': 'application/json' }),
  });

  const relayHandle = async (token: string, request: RegisterDeviceRequest): Promise<string> => {
    const ticketRes = await send(`${profile.address}${TICKET_PATH}`, {
      method: 'POST',
      headers: serverHeaders(token, false),
    });
    if (!ticketRes.ok) throw new Error(`ticket ${ticketRes.status}`);
    const ticket = deviceTicketResponseSchema.safeParse(ticketRes.body);
    if (!ticket.success) throw new Error('ticket unreadable');
    // Push tokens go only to the relay this build names.
    if (trimSlash(ticket.data.relay_url) !== relay) throw new RegistrationStopped('other relay');
    const body = relayDeviceRequestSchema.safeParse(
      request.platform === 'ios'
        ? {
            ticket: ticket.data.ticket,
            platform: 'ios',
            voip_token: request.fcm_token,
            ...(request.apns_token !== undefined && { apns_token: request.apns_token }),
          }
        : { ticket: ticket.data.ticket, platform: 'android', fcm_token: request.fcm_token },
    );
    if (!body.success) throw new RegistrationStopped('push tokens unusable');
    const relayRes = await send(`${relay}/v1/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body.data),
    });
    if (!relayRes.ok) throw new Error(`relay ${relayRes.status}`);
    const handle = relayDeviceResponseSchema.safeParse(relayRes.body);
    if (!handle.success) throw new Error('relay answer unreadable');
    return handle.data.handle;
  };

  return {
    async register(_deviceId, request) {
      await deps.ready();
      const token = deps.token();
      if (token === undefined) throw new Error('not signed in to the server');
      // A taken handle gets one fresh ticket and relay registration; never a loop.
      for (let attempt = 0; ; attempt += 1) {
        const handle = await relayHandle(token, request);
        const res = await send(`${profile.address}${PAIRED_DEVICE_RELAY_PATH}`, {
          method: 'PUT',
          headers: serverHeaders(token, true),
          body: JSON.stringify({ handle }),
        });
        if (res.ok) return;
        const code = (res.body as { error?: { code?: unknown } } | undefined)?.error?.code;
        if (res.status === 409 && code === 'relay_handle_taken') {
          if (attempt === 0) continue;
          throw new RegistrationStopped('relay_handle_taken');
        }
        throw new Error(`handle ${res.status}`);
      }
    },
    async unregister() {
      // No identity wait here: this runs while signing out, and an unchecked server gets nothing.
      const token = deps.token();
      if (token === undefined) return;
      // A failure is reported, not swallowed: sign-out keeps the device pending and a phone whose
      // notifications went off tries again on the next return. Already gone (404) is removed.
      const res = await send(`${profile.address}${PAIRED_DEVICE_RELAY_PATH}`, {
        method: 'DELETE',
        headers: serverHeaders(token, false),
      });
      if (!res.ok && res.status !== 404) throw new Error(`unregister ${res.status}`);
    },
  };
}

export interface RingRegistrationDeps {
  active(): ServerProfile;
  /** Everything but the register and unregister calls, shared by every profile. */
  base: Omit<PushRegistrationDeps, 'register' | 'unregister' | 'refreshMs'>;
  /** Twring's own service; never sent to a self-hosted server. */
  hosted: RegistrationCalls;
  selfhost(profile: SelfhostProfile): RegistrationCalls;
  sealSelfTest(): Promise<boolean>;
  reportSealSelfTestFailed(): void;
}

const keyOf = (profile: ServerProfile) =>
  profile.kind === 'selfhost' ? `selfhost:${profile.serverId}` : 'hosted';

/**
 * This phone's push registration for whichever server is active: one `PushRegistration` per
 * profile, so hosted calls only go to Twring and a server's calls only to that server.
 */
export function createRingRegistration(deps: RingRegistrationDeps) {
  let current: { key: string; registration: PushRegistration } | undefined;
  let sealTested = false;

  const sealTestOnce = () => {
    if (sealTested) return;
    sealTested = true;
    void deps
      .sealSelfTest()
      .catch(() => false)
      .then((ok) => {
        if (!ok) deps.reportSealSelfTestFailed();
      });
  };

  function registration(): PushRegistration {
    const profile = deps.active();
    const key = keyOf(profile);
    if (current?.key === key) return current.registration;
    // Still registered for the previous profile (paired without signing out): stop it with its
    // own calls, and only then read the push token, which that sign-out deletes.
    const after = current?.registration.signedOut() ?? Promise.resolve();
    const base = { ...deps.base, getToken: () => after.then(() => deps.base.getToken()) };
    const next =
      profile.kind === 'selfhost'
        ? new PushRegistration({
            ...base,
            ...deps.selfhost(profile),
            // The hosted pending-device id is not this server's.
            getPendingDeviceId: () => Promise.resolve(null),
            setPendingDeviceId: () => Promise.resolve(),
            refreshMs: SELFHOST_REFRESH_MS,
          })
        : new PushRegistration({ ...base, ...deps.hosted });
    current = { key, registration: next };
    return next;
  }

  return {
    current: registration,
    /** The active server changed: swap registrations now. */
    activeChanged(): void {
      registration();
    },
    /** Someone is signed in: a self-hosted server rings its person (the server's `user_ref`). */
    signedIn(userId: string): Promise<void> {
      const profile = deps.active();
      if (profile.kind === 'selfhost') {
        sealTestOnce();
        return registration().signedIn(profile.person.id);
      }
      return registration().signedIn(userId);
    },
    /** Switching made `serverId` active and checked: register for its rings now. */
    startForServer(serverId: string): Promise<void> {
      const profile = deps.active();
      if (profile.kind !== 'selfhost' || profile.serverId !== serverId) return Promise.resolve();
      return this.signedIn(profile.person.id);
    },
    /** Signing out of `serverId`: its rings stop (deletes the handle once). */
    stopForServer(serverId: string): Promise<void> {
      if (current?.key !== `selfhost:${serverId}`) return Promise.resolve();
      return current.registration.signedOut();
    },
  };
}

export type RingRegistration = ReturnType<typeof createRingRegistration>;
