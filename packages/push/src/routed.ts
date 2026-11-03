import type { PushOptions, PushOutcome, PushPayload, PushSender, PushTarget } from './fcm';

/**
 * Sends each phone through its platform's push service: FCM for Android, APNs for iOS. A phone
 * whose service is not configured is skipped.
 */
export class RoutedPushSender implements PushSender {
  constructor(private readonly senders: { android?: PushSender; ios?: PushSender }) {}

  send(target: PushTarget, data: PushPayload, options?: PushOptions): Promise<PushOutcome> {
    const sender = target.platform === 'ios' ? this.senders.ios : this.senders.android;
    return sender === undefined ? Promise.resolve('skipped') : sender.send(target, data, options);
  }

  /** The platforms whose phones can be rung. */
  ringPlatforms(): ('android' | 'ios')[] {
    return [
      ...(this.senders.android !== undefined ? (['android'] as const) : []),
      ...(this.senders.ios !== undefined ? (['ios'] as const) : []),
    ];
  }
}
