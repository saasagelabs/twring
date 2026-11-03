import { describe, expect, it, vi } from 'vitest';

const getAccess = vi.fn();
vi.mock('../api', () => ({
  twringApi: () => ({ getAccess }),
  apiErrorCopy: () => ({ message: 'Try again.', retryable: false }),
}));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('./memory', () => ({
  rememberedMember: () => Promise.resolve(undefined),
  rememberMember: () => Promise.resolve(),
}));
vi.mock('../servers/profiles', () => ({
  profileStore: { active: () => ({ kind: 'selfhost', serverId: 'srv_1' }) },
}));

import { checkAccess, getAccessState } from './store';

describe('access with a self-hosted server', () => {
  it('a paired person is a member with no request', async () => {
    await checkAccess({ status: 'signed_in', userId: 'per_1', name: 'Ann' });
    expect(getAccessState()).toEqual({ status: 'member' });
    expect(getAccess).not.toHaveBeenCalled();
  });
});
