/**
 * The provider refused the key itself: bad or revoked (401), out of credit or billing off (402),
 * or without permission (403). One rule for saving, calls, voice notes, Listen and samples.
 */
export function isKeyRefusal(status: number | undefined): boolean {
  return status === 401 || status === 402 || status === 403;
}
