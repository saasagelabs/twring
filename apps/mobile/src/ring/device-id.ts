import type { SecureKeyValue } from '../auth/storage';

export const DEVICE_ID_KEY = 'cord.push_device_id';

/**
 * This install's push-registration id. Not a secret: it only names this phone's registration.
 * A keychain that cannot be read (a locked phone woken by a ring) is an error, not "no id": a new
 * id would register the phone twice and move its token away from the real registration.
 */
export async function loadDeviceId(
  store: SecureKeyValue,
  platform: 'ios' | 'android',
): Promise<string> {
  const stored = await store.getItemAsync(DEVICE_ID_KEY);
  if (stored !== null && stored !== '') return stored;
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  const id = `${platform}-${hex.join('')}`;
  await store.setItemAsync(DEVICE_ID_KEY, id).catch(() => undefined);
  return id;
}
