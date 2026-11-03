import type { ConnectedApp } from '@twring/contracts';

export function connectedAppsState(apps: ConnectedApp[]) {
  return {
    empty: apps.length === 0,
    rows: [...apps].sort(
      (a, b) => Number(a.blocked) - Number(b.blocked) || a.name.localeCompare(b.name),
    ),
  };
}
