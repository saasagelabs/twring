import type { ServerProfile } from './profiles';

export interface ServerReadyDeps {
  active(): ServerProfile;
  /** Reads the saved servers and the active one's token (selfhost.start). */
  start(): Promise<void>;
  /** The active server's identity check; its token is released only if it passes. */
  check(): Promise<void>;
}

/** Hosted: at once. Self-hosted: once the saved servers are read and the identity check ran. */
export function serverReady(deps: ServerReadyDeps): Promise<void> {
  if (deps.active().kind !== 'selfhost') return Promise.resolve();
  return deps.start().then(() => deps.check());
}

/**
 * A ring answered at cold start. Hosted answers at once, as before; a self-hosted server's answer
 * waits for the identity check (a held server's next check). If that check does not pass, the
 * answer still runs, without the token, and fails with the usual copy.
 */
export function answerWhenReady(
  deps: { active(): ServerProfile; ready(): Promise<void> },
  answer: () => Promise<void>,
): Promise<void> {
  if (deps.active().kind !== 'selfhost') return answer();
  return deps
    .ready()
    .catch(() => undefined)
    .then(answer);
}
