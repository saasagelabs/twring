import type { AudioRoute, CallState, DeviceInfoMessage } from '@twring/contracts';

import type { AudioOutput } from './audio-routes';

/** What the phone says about itself. Metadata only (approved for "it misheard me" diagnosis). */
export interface DeviceFacts {
  platform?: 'android' | 'ios';
  os?: string;
  model?: string;
  appBuild?: string;
}

const LIVE: ReadonlySet<CallState['status']> = new Set([
  'LISTENING',
  'USER_SPEAKING',
  'AGENT_WORKING',
  'AGENT_SPEAKING',
]);

/**
 * Sends the device and audio route to the gateway once the call is live, then again whenever the
 * route changes, and once more after a reconnect. A new call starts over.
 */
export class DeviceReporter {
  private live = false;
  private sentRoute: AudioRoute | undefined;

  constructor(
    private readonly facts: DeviceFacts,
    private readonly send: (info: DeviceInfoMessage) => void,
  ) {}

  update(status: CallState['status'], output: AudioOutput | undefined): void {
    if (status === 'IDLE' || status === 'ENDED' || status === 'FAILED') {
      this.live = false;
      this.sentRoute = undefined;
      return;
    }
    if (status === 'RECONNECTING') {
      // The room (or the gateway) may have restarted: send the current route again once live.
      this.sentRoute = undefined;
      return;
    }
    if (LIVE.has(status)) this.live = true;
    if (!this.live) return;
    const route: AudioRoute = output ?? 'unknown';
    if (route === this.sentRoute) return;
    this.sentRoute = route;
    const { platform, os, model, appBuild } = this.facts;
    this.send({
      v: 1,
      type: 'device_info',
      route,
      ...(platform !== undefined && { platform }),
      ...(os !== undefined && { os: os.slice(0, 32) }),
      ...(model !== undefined && { model: model.slice(0, 64) }),
      ...(appBuild !== undefined && { app_build: appBuild.slice(0, 32) }),
    });
  }
}
