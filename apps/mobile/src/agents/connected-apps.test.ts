import { describe, expect, it } from 'vitest';
import { connectedAppsState } from './connected-apps';

describe('connected app list state', () => {
  it('shows an empty state and puts connected apps before blocked apps', () => {
    expect(connectedAppsState([])).toEqual({ empty: true, rows: [] });
    const apps = [
      { client_id: 'blocked', name: 'B', blocked: true },
      { client_id: 'active', name: 'A', blocked: false },
    ];
    expect(connectedAppsState(apps).rows.map((app) => app.client_id)).toEqual([
      'active',
      'blocked',
    ]);
    expect(apps[0]?.client_id).toBe('blocked');
  });
});
