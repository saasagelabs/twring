import type { RegisterDeviceRequest } from './protocol';
import { userRef } from '@twring/contracts';

export interface PushRegistrationDeps {
  /** The FCM token, or null when this build has no Firebase config. */
  getToken(): Promise<string | null>;
  /** Stable per install. */
  deviceId(): Promise<string>;
  register(deviceId: string, request: RegisterDeviceRequest): Promise<void>;
  unregister(deviceId: string): Promise<void>;
  setRingAccount(ref: string | null): void;
  deleteToken(): Promise<void>;
  getPendingDeviceId(): Promise<string | null>;
  setPendingDeviceId(id: string | null): Promise<void>;
  appVariant: RegisterDeviceRequest['app_variant'];
  /** Defaults to Android. */
  platform?: RegisterDeviceRequest['platform'];
  /** iOS: the alert token, sent along with the ring token when there is one. */
  getAlertToken?(): Promise<string | null>;
  /**
   * Notifications are allowed, so a ring can be shown. Until they are, no token is sent (Play Data
   * safety: the push token is optional). Defaults to always: iOS rings through CallKit without them.
   */
  notificationsAllowed?(): boolean;
  /** Clock for the re-registration throttle. Defaults to Date.now. */
  now?: () => number;
  /** How often the same token is sent again. Defaults to PUSH_REFRESH_MS. */
  refreshMs?: number;
}

/**
 * The same token is sent again at most this often (on app start or return). It keeps the server's
 * `updated_at` fresh, so an active phone is not the one evicted by the device limit, and a phone
 * that was evicted comes back.
 */
export const PUSH_REFRESH_MS = 12 * 60 * 60 * 1000;

/**
 * A registration that failed (offline, rate limited) is tried again after these delays, so the
 * phone can be rung without waiting for the next app open (review finding 6).
 */
export const REGISTER_RETRY_MS = [2_000, 8_000, 30_000] as const;

/** A registration that must not be retried now; the next app start tries again. */
export class RegistrationStopped extends Error {}

/**
 * Keeps this phone's FCM token registered with Twring while someone is signed in: on sign-in, on
 * token refresh, and removed again on sign-out (before the session goes) and account deletion.
 * Operations run one at a time, in order. Failures are swallowed: registering again on the next
 * sign-in or app start fixes a miss, and a phone that cannot be rung still calls out.
 */
export class PushRegistration {
  private active = false;
  private registeredToken: string | undefined;
  private registeredAlert: string | undefined;
  private registeredAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** This run already removed the token from the server because notifications are off. */
  private withdrawn = false;

  private readonly now: () => number;
  private readonly refreshMs: number;

  constructor(private readonly deps: PushRegistrationDeps) {
    this.now = deps.now ?? Date.now;
    this.refreshMs = deps.refreshMs ?? PUSH_REFRESH_MS;
  }

  /** Someone is signed in (at sign-in, and on each app start or return while signed in). */
  signedIn(userId: string): Promise<void> {
    this.active = true;
    this.deps.setRingAccount(userRef(userId));
    return this.run(async () => {
      if (!this.active) return;
      const pending = await this.deps.getPendingDeviceId();
      if (pending !== null) {
        try {
          await this.deps.unregister(pending);
          await this.deps.setPendingDeviceId(null);
        } catch {
          // A different account cannot unregister the previous owner's device. Registering the
          // current token still moves it to this account; a deleted token expires at FCM.
        }
      }
      if (!this.allowed()) {
        await this.withdraw();
        return;
      }
      this.withdrawn = false;
      const token = await this.deps.getToken();
      if (token !== null && token !== '') await this.registerToken(token);
    });
  }

  /** iOS delivered (or rotated) its alert token: send it with the current ring token. */
  alertTokenRefreshed(): Promise<void> {
    return this.run(async () => {
      if (!this.active) return;
      const token = this.registeredToken ?? (await this.deps.getToken());
      if (token !== null && token !== '') await this.registerToken(token);
    });
  }

  /** FCM rotated the token. */
  tokenRefreshed(token: string): Promise<void> {
    return this.run(async () => {
      if (this.active && token !== '') await this.registerToken(token);
    });
  }

  /** Before signing out or deleting the account: this phone must stop ringing for that user. */
  signedOut(): Promise<void> {
    const wasActive = this.active;
    this.active = false;
    this.cancelRetry();
    this.deps.setRingAccount(null);
    return this.run(async () => {
      if (!wasActive) return;
      this.registeredToken = undefined;
      this.registeredAlert = undefined;
      const id = await this.deps.deviceId();
      try {
        await this.deps.unregister(id);
        await this.deps.setPendingDeviceId(null);
      } catch {
        await this.deps.setPendingDeviceId(id);
      } finally {
        await this.deps.deleteToken().catch(() => undefined);
      }
    });
  }

  /**
   * The server removed this phone's registration while still signed in (Delete my data): the next
   * `signedIn` (app start or return) registers it again instead of skipping a known token.
   */
  forget(): void {
    void this.run(() => {
      this.registeredToken = undefined;
      return Promise.resolve();
    });
  }

  /** The token currently registered, for tests and diagnostics. */
  get registered(): string | undefined {
    return this.registeredToken;
  }

  private allowed(): boolean {
    return this.deps.notificationsAllowed?.() ?? true;
  }

  /**
   * Notifications are off: take this phone off the server, once per app run (an earlier app
   * version, or the person before switching them off, may have registered it). A failure is
   * tried again on the next app start or return.
   */
  private async withdraw(): Promise<void> {
    if (this.withdrawn) return;
    this.cancelRetry();
    this.registeredToken = undefined;
    this.registeredAlert = undefined;
    await this.deps.unregister(await this.deps.deviceId());
    this.withdrawn = true;
  }

  private async registerToken(token: string, attempt = 0): Promise<void> {
    if (!this.allowed()) return;
    const alert = (await this.deps.getAlertToken?.().catch(() => null)) ?? undefined;
    const unchanged = token === this.registeredToken && alert === this.registeredAlert;
    if (unchanged && this.now() - this.registeredAt < this.refreshMs) return;
    this.cancelRetry();
    try {
      await this.deps.register(await this.deps.deviceId(), {
        fcm_token: token,
        platform: this.deps.platform ?? 'android',
        app_variant: this.deps.appVariant,
        ...(alert !== undefined && alert !== '' && { apns_token: alert }),
      });
    } catch (error) {
      const delay = REGISTER_RETRY_MS[attempt];
      if (delay !== undefined && this.active && !(error instanceof RegistrationStopped)) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          void this.run(async () => {
            if (this.active) await this.registerToken(token, attempt + 1);
          });
        }, delay);
      }
      throw error;
    }
    // Signed out meanwhile: the sign-out queued behind this removes it again.
    this.registeredToken = token;
    this.registeredAlert = alert;
    this.registeredAt = this.now();
  }

  private cancelRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private run(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation).catch(() => undefined);
    this.queue = next;
    return next;
  }
}
