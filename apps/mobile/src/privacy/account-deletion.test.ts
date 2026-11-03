import { describe, expect, it, vi } from 'vitest';

import {
  accountToDeleteLabel,
  deleteAccount,
  endAppleSignIn,
  type AccountDeletionSteps,
} from './account-deletion';

const DELETED = {
  deleted: { agents: 1, credentials: 1, call_history: 3 },
  live_calls_ended: 0,
};

function steps(overrides: Partial<AccountDeletionSteps> = {}) {
  const order: string[] = [];
  const mocks = {
    deleteData: vi.fn(() => {
      order.push('data');
      return Promise.resolve(DELETED);
    }),
    deleteAccount: vi.fn(() => {
      order.push('account');
      return Promise.resolve();
    }),
    signOut: vi.fn(() => {
      order.push('sign_out');
      return Promise.resolve();
    }),
    ...overrides,
  };
  return { mocks, order };
}

describe('deleteAccount', () => {
  it('deletes the data, then the account, then signs out', async () => {
    const { mocks, order } = steps();
    expect(await deleteAccount(mocks)).toEqual({ status: 'done' });
    expect(order).toEqual(['data', 'account', 'sign_out']);
  });

  it('stops before the account when the data could not be deleted', async () => {
    const failure = new Error('offline');
    const { mocks } = steps({ deleteData: vi.fn(() => Promise.reject(failure)) });
    expect(await deleteAccount(mocks)).toEqual({ status: 'data_failed', error: failure });
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('reports data deleted but account not, and a retry finishes without deleting data again', async () => {
    const rpc = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('delete_my_account failed: PGRST202'))
      .mockResolvedValueOnce(undefined);
    const { mocks, order } = steps({ deleteAccount: rpc });

    const first = await deleteAccount(mocks);
    expect(first.status).toBe('account_failed');
    expect(mocks.signOut).not.toHaveBeenCalled();

    expect(await deleteAccount(mocks, 'account')).toEqual({ status: 'done' });
    expect(mocks.deleteData).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['data', 'sign_out']);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('still reports done when only the local sign-out fails', async () => {
    const { mocks } = steps({ signOut: vi.fn(() => Promise.reject(new Error('keychain'))) });
    expect(await deleteAccount(mocks)).toEqual({ status: 'done' });
  });
});

describe('deleteAccount for an Apple account', () => {
  it('ends Sign in with Apple first, then deletes as usual', async () => {
    const { mocks, order } = steps();
    const endApple = vi.fn(() => {
      order.push('apple');
      return Promise.resolve('done' as const);
    });
    expect(await deleteAccount({ ...mocks, endAppleSignIn: endApple })).toEqual({ status: 'done' });
    expect(order).toEqual(['apple', 'data', 'account', 'sign_out']);
  });

  it('deletes nothing when the person closes Apple’s confirmation', async () => {
    const { mocks, order } = steps();
    const result = await deleteAccount({
      ...mocks,
      endAppleSignIn: () => Promise.resolve('cancelled'),
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(order).toEqual([]);
  });

  it('does not ask Apple again when a retry finishes the account step', async () => {
    const { mocks, order } = steps();
    const endApple = vi.fn(() => Promise.resolve('done' as const));
    await deleteAccount({ ...mocks, endAppleSignIn: endApple }, 'account');
    expect(endApple).not.toHaveBeenCalled();
    expect(order).toEqual(['account', 'sign_out']);
  });
});

describe('endAppleSignIn', () => {
  it('revokes with the fresh code from Apple', async () => {
    const revoke = vi.fn(() => Promise.resolve());
    await expect(endAppleSignIn(() => Promise.resolve('code-1'), revoke)).resolves.toBe('done');
    expect(revoke).toHaveBeenCalledWith('code-1');
  });

  it('is cancelled only when the person closes the sheet', async () => {
    const revoke = vi.fn(() => Promise.resolve());
    await expect(endAppleSignIn(() => Promise.resolve(undefined), revoke)).resolves.toBe(
      'cancelled',
    );
    expect(revoke).not.toHaveBeenCalled();
  });

  it('never blocks the deletion when Apple or the server fails', async () => {
    await expect(
      endAppleSignIn(
        () => Promise.reject(new Error('apple sheet failed')),
        () => Promise.resolve(),
      ),
    ).resolves.toBe('done');
    await expect(
      endAppleSignIn(
        () => Promise.resolve('code'),
        () => Promise.reject(new Error('502')),
      ),
    ).resolves.toBe('done');
  });
});

describe('accountToDeleteLabel', () => {
  it('names the account by its email, and says when it signs in with Apple', () => {
    expect(accountToDeleteLabel({ email: 'a@example.com' })).toBe('a@example.com');
    expect(accountToDeleteLabel({ email: 'x@privaterelay.appleid.com', apple: true })).toBe(
      'x@privaterelay.appleid.com (Sign in with Apple)',
    );
  });

  it('still says which kind of account without an email', () => {
    expect(accountToDeleteLabel({ apple: true })).toBe('the account you signed in to with Apple');
    expect(accountToDeleteLabel({ email: ' ' })).toBe('this account');
    expect(accountToDeleteLabel({})).toBe('this account');
  });
});
