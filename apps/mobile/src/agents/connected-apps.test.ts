import { describe, expect, it } from 'vitest';
import { connectedAppsState } from './connected-apps';

describe('connected app list state', () => {
  it('is empty with no apps', () => {
    expect(connectedAppsState([])).toEqual({ empty: true, connected: [], removed: [] });
  });

  it('shows an app connected more than once as one row, with its latest use', () => {
    const state = connectedAppsState([
      { client_id: 'c1', name: 'Cursor', blocked: false, last_used_at: '2026-11-21T16:56:00Z' },
      { client_id: 'c2', name: 'cursor ', blocked: false, last_used_at: '2026-11-21T17:06:00Z' },
      { client_id: 'c3', name: 'Cursor', blocked: false },
    ]);
    expect(state.connected).toEqual([
      {
        key: 'cursor',
        name: 'Cursor',
        clientIds: ['c1', 'c2', 'c3'],
        lastUsedAt: '2026-11-21T17:06:00Z',
      },
    ]);
    expect(state.empty).toBe(false);
  });

  it('puts the most recently used app first, and never-used apps last by name', () => {
    const state = connectedAppsState([
      { client_id: 'a', name: 'opencode', blocked: false },
      { client_id: 'b', name: 'Claude', blocked: false, last_used_at: '2026-11-21T10:00:00Z' },
      { client_id: 'c', name: 'Cursor', blocked: false, last_used_at: '2026-11-21T12:00:00Z' },
      { client_id: 'd', name: 'Grok', blocked: false },
    ]);
    expect(state.connected.map((app) => app.name)).toEqual([
      'Cursor',
      'Claude',
      'Grok',
      'opencode',
    ]);
  });

  it('lists removed apps once each, and hides one that is connected again', () => {
    const state = connectedAppsState([
      { client_id: 'old1', name: 'Claude Code', blocked: true },
      { client_id: 'old2', name: 'Claude Code', blocked: true },
      { client_id: 'old3', name: 'Cursor', blocked: true },
      { client_id: 'new', name: 'Cursor', blocked: false },
    ]);
    expect(state.connected.map((app) => app.clientIds)).toEqual([['new']]);
    expect(state.removed).toEqual([
      { key: 'claude code', name: 'Claude Code', clientIds: ['old1', 'old2'] },
    ]);
  });

  it('sorts an app with an unreadable last-used time as never used', () => {
    const state = connectedAppsState([
      { client_id: 'a', name: 'Broken', blocked: false, last_used_at: 'not a date' },
      { client_id: 'b', name: 'Claude', blocked: false, last_used_at: '2026-11-21T10:00:00Z' },
      { client_id: 'c', name: 'Alpha', blocked: false },
    ]);
    expect(state.connected.map((app) => app.name)).toEqual(['Claude', 'Alpha', 'Broken']);
  });

  it('is not empty when only removed apps are left', () => {
    const state = connectedAppsState([{ client_id: 'x', name: 'Claude', blocked: true }]);
    expect(state.empty).toBe(false);
    expect(state.connected).toEqual([]);
  });
});
