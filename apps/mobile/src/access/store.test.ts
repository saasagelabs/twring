import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAccess = vi.fn();
const redeemInvite = vi.fn();
vi.mock('../api', () => ({
  twringApi: () => ({ getAccess, redeemInvite }),
  apiErrorCopy: (error: { code?: string }) => ({
    message:
      error.code === 'invite_invalid'
        ? "That code isn't valid. Check it, or ask for a new one."
        : 'Try again.',
    retryable: false,
  }),
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));

const memory: { member: string | undefined } = { member: undefined };
vi.mock('./memory', () => ({
  rememberedMember: () => Promise.resolve(memory.member),
  rememberMember: (userId: string | undefined) => {
    memory.member = userId;
    return Promise.resolve();
  },
}));

import { ApiError } from '../api/client';
import {
  checkAccess,
  getAccessState,
  markNotInvited,
  recheckAccess,
  redeem,
  resetAccess,
} from './store';

const alice = { status: 'signed_in', userId: 'alice', email: 'alice@example.com' } as const;
const bob = { status: 'signed_in', userId: 'bob', email: 'bob@example.com' } as const;

beforeEach(() => {
  getAccess.mockReset();
  redeemInvite.mockReset();
  resetAccess({ status: 'signed_out' });
  memory.member = undefined;
});

describe('access store', () => {
  it('checks a member once per signed-in user', async () => {
    getAccess.mockResolvedValue({ member: true });
    await checkAccess(alice);
    await checkAccess(alice);
    expect(getAccess).toHaveBeenCalledOnce();
    expect(getAccessState()).toEqual({ status: 'member' });
  });

  it('keeps a waitlisted email', async () => {
    getAccess.mockResolvedValue({ member: false, email: alice.email });
    await checkAccess(alice);
    expect(getAccessState()).toEqual({ status: 'waitlist', email: alice.email });
  });

  it('accepts the client 404 compatibility result as a member', async () => {
    getAccess.mockResolvedValue({ member: true });
    await checkAccess(alice);
    expect(getAccessState().status).toBe('member');
  });

  it('shows error and allows a retry', async () => {
    getAccess
      .mockRejectedValueOnce(new ApiError('network'))
      .mockResolvedValueOnce({ member: true });
    await checkAccess(alice);
    expect(getAccessState()).toEqual({ status: 'error' });
    await checkAccess();
    expect(getAccessState()).toEqual({ status: 'member' });
  });

  it('ends a stalled check after eight seconds', async () => {
    vi.useFakeTimers();
    try {
      getAccess.mockImplementation(() => new Promise(() => undefined));
      const pending = checkAccess(alice);
      await vi.advanceTimersByTimeAsync(8_000);
      await pending;
      expect(getAccessState()).toEqual({ status: 'error' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets disabled auth through without a request', async () => {
    await checkAccess({ status: 'disabled' });
    expect(getAccessState()).toEqual({ status: 'member' });
    expect(getAccess).not.toHaveBeenCalled();
  });

  it('resets on sign-out and user change', async () => {
    getAccess.mockResolvedValue({ member: true });
    await checkAccess(alice);
    resetAccess(bob);
    expect(getAccessState()).toEqual({ status: 'unknown' });
    await checkAccess(bob);
    expect(getAccess).toHaveBeenCalledTimes(2);
    expect(getAccessState()).toEqual({ status: 'member' });
    resetAccess({ status: 'signed_out' });
    expect(getAccessState()).toEqual({ status: 'unknown' });
  });

  it('redeems normalized code and becomes a member', async () => {
    getAccess.mockResolvedValue({ member: false, email: alice.email });
    redeemInvite.mockResolvedValue({ member: true, email: alice.email });
    await checkAccess(alice);
    expect(await redeem('123 456')).toEqual({ ok: true });
    expect(redeemInvite).toHaveBeenCalledWith('123456');
    expect(getAccessState()).toEqual({ status: 'member' });
  });

  it('keeps the waitlist and copy after an invalid invite', async () => {
    getAccess.mockResolvedValue({ member: false, email: alice.email });
    redeemInvite.mockRejectedValue(new ApiError('http', 'invite_invalid'));
    await checkAccess(alice);
    expect(await redeem('123456')).toMatchObject({
      ok: false,
      error: { message: "That code isn't valid. Check it, or ask for a new one." },
    });
    expect(getAccessState()).toEqual({ status: 'waitlist', email: alice.email });
  });

  it('rejects short codes without a request', async () => {
    expect(await redeem('12345')).toMatchObject({ ok: false });
    expect(redeemInvite).not.toHaveBeenCalled();
  });

  it('moves a revoked member to the waitlist', async () => {
    getAccess.mockResolvedValue({ member: true });
    await checkAccess(alice);
    markNotInvited();
    expect(getAccessState()).toEqual({ status: 'waitlist', email: alice.email });
  });
});

describe('checking again from the waiting screen', () => {
  it('lets someone in once a place frees up, and remembers them', async () => {
    getAccess.mockResolvedValueOnce({ member: false, email: alice.email });
    await checkAccess(alice);
    getAccess.mockResolvedValueOnce({ member: true });
    await recheckAccess();
    expect(getAccessState()).toEqual({ status: 'member' });
    expect(memory.member).toBe('alice');
  });

  it('stays on the waiting screen without a loading flash when still full', async () => {
    getAccess.mockResolvedValueOnce({ member: false, email: alice.email });
    await checkAccess(alice);
    const seen: string[] = [];
    getAccess.mockImplementationOnce(() => {
      seen.push(getAccessState().status);
      return Promise.resolve({ member: false, email: alice.email });
    });
    await recheckAccess();
    expect(seen).toEqual(['waitlist']);
    expect(getAccessState()).toEqual({ status: 'waitlist', email: alice.email });
  });

  it('a failed check keeps the waiting screen', async () => {
    getAccess.mockResolvedValueOnce({ member: false, email: alice.email });
    await checkAccess(alice);
    getAccess.mockRejectedValueOnce(new ApiError('network'));
    await recheckAccess();
    expect(getAccessState().status).toBe('waitlist');
  });

  it('asks once at a time, and only from the waiting screen', async () => {
    await recheckAccess();
    expect(getAccess).not.toHaveBeenCalled();
    getAccess.mockResolvedValueOnce({ member: false, email: alice.email });
    await checkAccess(alice);
    getAccess.mockResolvedValue({ member: false, email: alice.email });
    await Promise.all([recheckAccess(), recheckAccess()]);
    expect(getAccess).toHaveBeenCalledTimes(2);
  });

  it('a switch to another account asks for that account, not the old one', async () => {
    getAccess.mockResolvedValueOnce({ member: false, email: alice.email });
    await checkAccess(alice);
    getAccess.mockReturnValueOnce(new Promise(() => undefined));
    void recheckAccess();
    getAccess.mockResolvedValueOnce({ member: false, email: bob.email });
    await checkAccess(bob);
    getAccess.mockResolvedValueOnce({ member: true });
    await recheckAccess();
    expect(getAccessState()).toEqual({ status: 'member' });
    expect(memory.member).toBe('bob');
  });

  it('ignores an answer for an account that signed out meanwhile', async () => {
    getAccess.mockResolvedValueOnce({ member: false, email: alice.email });
    await checkAccess(alice);
    let answer: (value: unknown) => void = () => undefined;
    getAccess.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const pending = recheckAccess();
    resetAccess({ status: 'signed_out' });
    answer({ member: true });
    await pending;
    expect(getAccessState()).toEqual({ status: 'unknown' });
  });
});

describe('a member this phone remembers', () => {
  it('is remembered once confirmed, by the check or by a code', async () => {
    getAccess.mockResolvedValue({ member: true });
    await checkAccess(alice);
    expect(memory.member).toBe('alice');
    resetAccess({ status: 'signed_out' });
    expect(memory.member).toBeUndefined();
    getAccess.mockResolvedValue({ member: false, email: bob.email });
    redeemInvite.mockResolvedValue({ member: true, email: bob.email });
    await checkAccess(bob);
    expect(await redeem('123456')).toEqual({ ok: true });
    expect(memory.member).toBe('bob');
  });

  it('goes straight in and stays in when the check fails', async () => {
    memory.member = 'alice';
    let fail: (error: Error) => void = () => undefined;
    getAccess.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const checking = checkAccess(alice);
    await vi.waitFor(() => expect(getAccessState()).toEqual({ status: 'member' }));
    fail(new ApiError('network'));
    await checking;
    expect(getAccessState()).toEqual({ status: 'member' });
    expect(memory.member).toBe('alice');
  });

  it('is dropped to the waitlist and forgotten when the server says no', async () => {
    memory.member = 'alice';
    getAccess.mockResolvedValue({ member: false, email: alice.email });
    await checkAccess(alice);
    expect(getAccessState()).toEqual({ status: 'waitlist', email: alice.email });
    expect(memory.member).toBeUndefined();
  });

  it('is forgotten on not_invited', async () => {
    memory.member = 'alice';
    getAccess.mockResolvedValue({ member: true });
    await checkAccess(alice);
    markNotInvited();
    expect(memory.member).toBeUndefined();
    expect(getAccessState()).toEqual({ status: 'waitlist', email: alice.email });
  });

  it('never lets another account in', async () => {
    memory.member = 'bob';
    getAccess.mockRejectedValue(new ApiError('network'));
    await checkAccess(alice);
    expect(getAccessState()).toEqual({ status: 'error' });
  });
});
