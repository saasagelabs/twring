import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** 20 base32 characters = 100 random bits: unguessable, and URL- and room-name-safe. */
function randomSuffix(): string {
  const bytes = randomBytes(20);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return out;
}

export interface CallIds {
  callId: string;
  sessionId: string;
  room: string;
  callerIdentity: string;
}

export function newCallIds(): CallIds {
  const suffix = randomSuffix();
  return {
    callId: `call_${suffix}`,
    sessionId: `sess_${randomSuffix()}`,
    // Room names are visible to every participant: IDs only, never user data or secrets.
    room: `cord-call-${suffix}`,
    callerIdentity: `caller-${suffix}`,
  };
}

export function newAgentId(): string {
  return `agt_${randomSuffix()}`;
}
