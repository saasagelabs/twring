import type { DeleteMyDataResponse } from '@twring/contracts';

/**
 * Full account deletion (Settings → Delete account), in the order that never leaves data behind
 * an account that is gone: for an Apple account, Sign in with Apple is ended first (Apple asks the
 * person to confirm); then Twring data (gateway), then the sign-in account (Supabase RPC
 * `delete_my_account`), then a local sign-out. Each step is safe to repeat.
 */
export interface AccountDeletionSteps {
  /** Apple accounts only: `cancelled` when the person closes Apple's sheet; nothing is deleted. */
  endAppleSignIn?(): Promise<'done' | 'cancelled'>;
  deleteData(): Promise<DeleteMyDataResponse>;
  deleteAccount(): Promise<void>;
  signOut(): Promise<void>;
}

/** Where a retry picks up: after a partial failure, the data step is not repeated. */
export type AccountDeletionStart = 'data' | 'account';

export type AccountDeletionResult =
  | { status: 'done' }
  /** The person closed Apple's confirmation; nothing was deleted. */
  | { status: 'cancelled' }
  /** Nothing was deleted; retry from the start. */
  | { status: 'data_failed'; error: unknown }
  /** Data deleted, account not; retry with `from: 'account'`. */
  | { status: 'account_failed'; error: unknown };

export async function deleteAccount(
  steps: AccountDeletionSteps,
  from: AccountDeletionStart = 'data',
): Promise<AccountDeletionResult> {
  if (from === 'data') {
    if (steps.endAppleSignIn !== undefined && (await steps.endAppleSignIn()) === 'cancelled') {
      return { status: 'cancelled' };
    }
    try {
      await steps.deleteData();
    } catch (error) {
      return { status: 'data_failed', error };
    }
  }
  try {
    await steps.deleteAccount();
  } catch (error) {
    return { status: 'account_failed', error };
  }
  // The account is gone either way; a failed local sign-out must not report a failure.
  await steps.signOut().catch(() => undefined);
  return { status: 'done' };
}

/**
 * Ends Sign in with Apple with a fresh authorization code.
 * Only closing Apple's sheet stops the deletion: if Apple or the server fails, the account is
 * still deleted (the server logs the failure), so a person is never stuck with an account.
 */
export async function endAppleSignIn(
  authorizationCode: () => Promise<string | undefined>,
  revoke: (code: string) => Promise<void>,
): Promise<'done' | 'cancelled'> {
  let code: string | undefined;
  try {
    code = await authorizationCode();
  } catch {
    return 'done';
  }
  if (code === undefined) return 'cancelled';
  await revoke(code).catch(() => undefined);
  return 'done';
}

/**
 * The account Delete account is about to delete, as the person knows it: its email, and whether
 * it signs in with Apple. Someone with two accounts (Google and an Apple ID) must see which one
 * goes before confirming.
 */
export function accountToDeleteLabel(account: { email?: string; apple?: true }): string {
  const email = account.email?.trim();
  if (email) return account.apple ? `${email} (Sign in with Apple)` : email;
  return account.apple ? 'the account you signed in to with Apple' : 'this account';
}

/** Where users write about privacy and deletion; matches the gateway's CORD_SUPPORT_EMAIL. */
export const SUPPORT_EMAIL = 'support@twring.com';

/** Plain copy for a partial failure: what happened and what to do next. */
export const ACCOUNT_NOT_DELETED =
  "Your data is deleted, but your account couldn't be deleted just now. Try again, or write to " +
  `${SUPPORT_EMAIL} to finish.`;
