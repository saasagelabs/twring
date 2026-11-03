import { secureStore } from '@/platform/secure-store';

const MEMBER_KEY = 'twring.access_member';

/**
 * The user id last confirmed as a member on this phone. It only spares a known member the
 * splash wait (an incoming call must not hang on a slow access check); the server's gate
 * still decides, and a `not_invited` answer forgets it.
 */
export async function rememberedMember(): Promise<string | undefined> {
  return (await secureStore.getItemAsync(MEMBER_KEY).catch(() => null)) ?? undefined;
}

export async function rememberMember(userId: string | undefined): Promise<void> {
  await (
    userId === undefined
      ? secureStore.deleteItemAsync(MEMBER_KEY)
      : secureStore.setItemAsync(MEMBER_KEY, userId)
  ).catch(() => undefined);
}
