import { AuthError, bearerToken, type Authenticator } from '../auth';

import type { DeviceTokenRepository } from './people';

export const REMOVED_PHONE_MESSAGE =
  'This phone was removed from the server. Ask an admin for a new code.';

/**
 * `AUTH_MODE=pairing`: the bearer token is a paired phone's device token; the acting user is the
 * person it belongs to (`resolve` loads them). Unknown, removed phones and removed people all answer 401.
 */
export function pairingAuthenticator(devices: DeviceTokenRepository): Authenticator {
  return async (request) => {
    const token = bearerToken(request);
    if (token === undefined || !token.startsWith('twd_')) {
      throw new AuthError(401, 'auth_required', 'Pair this phone with your server first.');
    }
    const found = await devices.resolve(token);
    if (
      found === undefined ||
      found.device.removed_at !== undefined ||
      found.person === undefined ||
      found.person.removed_at !== undefined
    ) {
      throw new AuthError(401, 'device_removed', REMOVED_PHONE_MESSAGE);
    }
    return { id: found.person.id, name: found.person.display_name };
  };
}
