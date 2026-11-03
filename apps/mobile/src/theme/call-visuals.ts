import type { CallState } from '@twring/contracts';

import type { VisualizerMode } from '@/call/levels';

import type { Palette } from './tokens';

type CallStatus = CallState['status'];

/** Which semantic color the voice orb wears in each mode. */
export type OrbRole =
  'idle' | 'listening' | 'userSpeaking' | 'working' | 'speaking' | 'reconnecting';

export function orbRole(kind: VisualizerMode['kind']): OrbRole {
  switch (kind) {
    case 'idle':
      return 'idle';
    case 'listening':
      return 'listening';
    case 'user':
      return 'userSpeaking';
    case 'working':
      return 'working';
    case 'agent':
      return 'speaking';
    case 'reconnecting':
      return 'reconnecting';
  }
}

export function orbColor(role: OrbRole, palette: Palette): string {
  switch (role) {
    case 'idle':
      return palette.working;
    case 'listening':
      return palette.listening;
    case 'userSpeaking':
      return palette.userSpeaking;
    case 'working':
      return palette.working;
    case 'speaking':
      return palette.speaking;
    case 'reconnecting':
      return palette.reconnecting;
  }
}

/** Real level 0…1, clamped; anything non-finite is silence. */
export function safeLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

/** Core circle scale: 1.0 in silence, 1.25 at full level. */
export const CORE_MAX_GROWTH = 0.25;
export function coreScale(level: number): number {
  return 1 + CORE_MAX_GROWTH * safeLevel(level);
}

/** Halo ring `index` (0 = innermost): a resting size plus a larger swing than the core. */
export const HALO_REST = [1.3, 1.6, 1.9] as const;
export const HALO_GROWTH = [0.3, 0.4, 0.5] as const;
export function haloScale(index: 0 | 1 | 2, level: number): number {
  return HALO_REST[index] + HALO_GROWTH[index] * safeLevel(level);
}

/** Avatar backgrounds: calm mid-tones that all carry white text. */
export const AVATAR_COLORS = [
  '#3B6FD8',
  '#7A5AF0',
  '#1F8A70',
  '#C2571A',
  '#B03A7A',
  '#2A8BA8',
  '#8A6D1E',
  '#5B6478',
] as const;

/** A stable color per agent id (FNV-1a), so an agent keeps its color across screens and launches. */
export function avatarColor(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return AVATAR_COLORS[(hash >>> 0) % AVATAR_COLORS.length];
}

export function avatarInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first === undefined ? '?' : first.toUpperCase();
}

/** The small pill at the top of the call: is the line up? Separate from what the agent is doing. */
export type PillTone = 'connecting' | 'connected' | 'reconnecting';

export function connectionPill(status: CallStatus): { label: string; tone: PillTone } | undefined {
  switch (status) {
    case 'PREPARING':
    case 'CONNECTING':
      return { label: 'Connecting…', tone: 'connecting' };
    case 'LISTENING':
    case 'USER_SPEAKING':
    case 'AGENT_WORKING':
    case 'AGENT_SPEAKING':
    case 'ENDING':
      return { label: 'Connected', tone: 'connected' };
    case 'RECONNECTING':
      return { label: 'Reconnecting…', tone: 'reconnecting' };
    case 'IDLE':
    case 'ENDED':
    case 'FAILED':
      return undefined;
  }
}
