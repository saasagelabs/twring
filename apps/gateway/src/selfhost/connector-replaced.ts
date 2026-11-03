import type { ConnectorIdentity } from '../connectors/hub';

export const CONNECTOR_REPLACED_MESSAGE =
  "Your computer link was opened from another place. If that wasn't you, link your computer again.";

/** At most one notice per computer per hour. */
const NOTICE_EVERY_MS = 60 * 60_000;

/**
 * Self-hosted: tells a computer's owner, in a chat, that its link was opened from another place.
 * Rate-limited per computer; a failed delivery is dropped, never thrown.
 */
export function connectorReplacedNotifier(options: {
  now?: () => number;
  deliver: (userId: string, connectorId: string, text: string) => Promise<void>;
}): (identity: ConnectorIdentity) => Promise<void> {
  const now = options.now ?? Date.now;
  const last = new Map<string, number>();
  return async (identity) => {
    const at = now();
    const previous = last.get(identity.connectorId);
    if (previous !== undefined && at - previous < NOTICE_EVERY_MS) return;
    last.set(identity.connectorId, at);
    try {
      await options.deliver(identity.userId, identity.connectorId, CONNECTOR_REPLACED_MESSAGE);
    } catch {
      // Best effort: the warn log line already recorded it.
    }
  };
}
