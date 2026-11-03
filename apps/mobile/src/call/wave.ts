import type { CallState } from '@twring/contracts';

export type WaveMode = 'live' | 'frozen' | 'flat';
export type OrbLook = 'you' | 'agent' | 'working' | 'idle' | 'connecting' | 'reconnecting';

export interface CallLook {
  who: 'you' | 'agent' | 'none';
  orb: OrbLook;
  pill: { tone: 'you' | 'agent' | 'warning' | 'neutral' | 'muted'; active: boolean };
  agentWave: WaveMode;
  youWave: WaveMode;
}

export function waveIntensity(level: number): number {
  if (Number.isNaN(level) || level < 0) return 0.18;
  return 0.18 + 0.82 * Math.min(1, Math.sqrt(level) * 1.6);
}

export function callLook(
  status: CallState['status'],
  muted: boolean,
  _hasActivity: boolean,
): CallLook {
  let look: CallLook;
  switch (status) {
    case 'PREPARING':
    case 'CONNECTING':
      look = {
        who: 'none',
        orb: 'connecting',
        pill: { tone: 'neutral', active: false },
        agentWave: 'live',
        youWave: 'live',
      };
      break;
    case 'LISTENING':
      look = {
        who: 'none',
        orb: 'idle',
        pill: { tone: 'you', active: false },
        agentWave: 'live',
        youWave: 'live',
      };
      break;
    case 'USER_SPEAKING':
      look = {
        who: 'you',
        orb: 'you',
        pill: { tone: 'you', active: true },
        agentWave: 'live',
        youWave: 'live',
      };
      break;
    case 'AGENT_WORKING':
      look = {
        who: 'none',
        orb: 'working',
        pill: { tone: 'agent', active: false },
        agentWave: 'live',
        youWave: 'live',
      };
      break;
    case 'AGENT_SPEAKING':
      look = {
        who: 'agent',
        orb: 'agent',
        pill: { tone: 'agent', active: true },
        agentWave: 'live',
        youWave: 'live',
      };
      break;
    case 'RECONNECTING':
      look = {
        who: 'none',
        orb: 'reconnecting',
        pill: { tone: 'warning', active: true },
        agentWave: 'frozen',
        youWave: 'frozen',
      };
      break;
    case 'ENDING':
    case 'ENDED':
    case 'FAILED':
    case 'IDLE':
      look = {
        who: 'none',
        orb: 'idle',
        pill: { tone: 'neutral', active: false },
        agentWave: 'flat',
        youWave: 'flat',
      };
      break;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }

  if (!muted) return look;
  return {
    ...look,
    who: look.who === 'you' ? 'none' : look.who,
    orb: look.orb === 'you' ? 'idle' : look.orb,
    pill: status === 'RECONNECTING' ? look.pill : { tone: 'muted', active: false },
    youWave: 'flat',
  };
}
