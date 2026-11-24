/**
 * Whether private chats are on, asked at most once per app session per server and account
 * (`GET /v1/e2e/devices`, P3b ruling). "on" and "off" are remembered; "unknown" (offline, a server
 * error) is treated as off for now and asked again next time.
 */
export type PrivateAvailability = 'on' | 'off' | 'unknown';

export class PrivateAvailabilityCache {
  private readonly known = new Map<string, 'on' | 'off'>();
  private readonly asking = new Map<string, Promise<PrivateAvailability>>();

  /** The remembered answer for this server and account, if any. */
  peek(key: string): 'on' | 'off' | undefined {
    return this.known.get(key);
  }

  ask(key: string, fetchStatus: () => Promise<PrivateAvailability>): Promise<PrivateAvailability> {
    const known = this.known.get(key);
    if (known !== undefined) return Promise.resolve(known);
    let work = this.asking.get(key);
    if (work === undefined) {
      work = fetchStatus()
        .catch((): PrivateAvailability => 'unknown')
        .then((status) => {
          if (status !== 'unknown') this.known.set(key, status);
          return status;
        })
        .finally(() => this.asking.delete(key));
      this.asking.set(key, work);
    }
    return work;
  }
}

/** The app's one cache, for this app session. */
export const privateAvailability = new PrivateAvailabilityCache();
