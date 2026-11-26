import type { E2eDevice } from '@twring/contracts';

/** Active phones on the account other than this one (the ones that could approve this phone). */
export async function otherPhones(
  list: () => Promise<E2eDevice[]>,
  selfId: string | undefined,
): Promise<{ id: string; name: string }[]> {
  return (await list())
    .filter((d) => d.kind === 'phone' && d.revoked_at === undefined && d.id !== selfId)
    .map((d) => ({ id: d.id, name: d.name }));
}
