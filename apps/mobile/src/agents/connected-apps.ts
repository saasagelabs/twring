import type { ConnectedApp } from '@twring/contracts';

/**
 * One app as the owner sees it. Some apps (Cursor, for one) register again every time they are
 * connected, so the same app can sit behind several connections: they show as one row, and
 * removing or allowing the row acts on all of them.
 */
export interface AppGroup {
  key: string;
  name: string;
  clientIds: string[];
  lastUsedAt?: string;
}

const keyOf = (name: string) => name.trim().toLowerCase();

function group(apps: ConnectedApp[]): AppGroup[] {
  const groups = new Map<string, AppGroup>();
  for (const app of apps) {
    const key = keyOf(app.name);
    const found = groups.get(key);
    if (found === undefined) {
      groups.set(key, {
        key,
        name: app.name.trim(),
        clientIds: [app.client_id],
        ...(app.last_used_at !== undefined && { lastUsedAt: app.last_used_at }),
      });
      continue;
    }
    found.clientIds.push(app.client_id);
    if (
      app.last_used_at !== undefined &&
      (found.lastUsedAt === undefined ||
        Date.parse(app.last_used_at) > Date.parse(found.lastUsedAt))
    ) {
      found.lastUsedAt = app.last_used_at;
    }
  }
  return [...groups.values()];
}

const used = (app: AppGroup) => (app.lastUsedAt === undefined ? 0 : Date.parse(app.lastUsedAt));

/**
 * Connected apps, most recently used first; removed apps by name, leaving out any the owner has
 * connected again (its old removed connection would only look like a duplicate).
 */
export function connectedAppsState(apps: ConnectedApp[]) {
  const connected = group(apps.filter((app) => !app.blocked)).sort(
    (a, b) => used(b) - used(a) || a.name.localeCompare(b.name),
  );
  const live = new Set(connected.map((app) => app.key));
  const removed = group(apps.filter((app) => app.blocked))
    .filter((app) => !live.has(app.key))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { empty: connected.length === 0 && removed.length === 0, connected, removed };
}
