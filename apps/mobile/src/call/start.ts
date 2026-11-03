import type { CreateCallResponse } from '@twring/contracts';
import { router } from 'expo-router';

import { voicePreview } from '@/platform/voice-preview';

import { callController } from './session';

/** Who the call screen is talking to. No agent means the development test line. */
export interface CallTarget {
  agentId?: string;
  name?: string;
}

/**
 * Starts a call and opens the call screen, which reads the target back from its params.
 * `answered`: the session of an answered invite, joined instead of placing a new call; the call
 * screen then replaces the incoming-call screen.
 * `open: false` (iOS, answered on the system call screen): joins without opening the call screen;
 * the caller opens it once the app is in front.
 */
export function startCall(
  target: CallTarget = {},
  answered?: CreateCallResponse,
  { open = true }: { open?: boolean } = {},
): void {
  const controller = callController();
  if (controller === undefined) return;
  // A voice sample must never play over (or fight the audio session of) a call.
  voicePreview.stop();
  void controller.start(
    target.agentId !== undefined ? { agent_id: target.agentId } : {},
    target.name,
    answered,
  );
  if (!open) return;
  const route = {
    pathname: '/call' as const,
    params: {
      ...(target.agentId !== undefined && { agentId: target.agentId }),
      ...(target.name !== undefined && { name: target.name }),
    },
  };
  if (answered === undefined) router.push(route);
  else router.replace(route);
}
