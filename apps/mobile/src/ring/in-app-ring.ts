/**
 * Whether a ring opens the app's own ring screen. On iPhone the system call screen (CallKit)
 * shows every ring and an answer there is handled without drawing (system-answer.ts); opening the
 * app's screen as well raced that answer and left a "Missed call" screen stuck over the call.
 */
export function showsInAppRing(options: {
  /** The platform shows rings on the system call screen (iOS). */
  systemRingScreen: boolean;
  /** The ring the app's screen shows now, if any. */
  showing: string | undefined;
  inviteId: string;
  /** On a call already: the server refuses the answer anyway (call_in_progress). */
  inCall: boolean;
}): boolean {
  return !options.systemRingScreen && options.showing !== options.inviteId && !options.inCall;
}
