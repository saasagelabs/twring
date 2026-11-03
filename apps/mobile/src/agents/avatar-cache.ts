import { Directory, File, Paths } from 'expo-file-system';

import type { TwringApi } from '@/api/client';

/** The version is part of the filename so a changed photo never shows stale bytes. */
export async function cachedAgentAvatar(
  api: Pick<TwringApi, 'agentAvatarUrl'>,
  agentId: string,
  version: number,
): Promise<string> {
  const cache = new Directory(Paths.cache);
  const name = `avatar-${agentId}-${version}.jpg`;
  const target = new File(cache, name);
  if (!target.exists) {
    const source = await api.agentAvatarUrl(agentId);
    await File.downloadFileAsync(source.uri, target, { headers: source.headers, idempotent: true });
  }
  for (const entry of cache.list()) {
    if (
      entry instanceof File &&
      entry.name.startsWith(`avatar-${agentId}-`) &&
      entry.name !== name
    ) {
      entry.delete();
    }
  }
  return target.uri;
}
