/**
 * Whether the system call screen owns the audio session (iOS CallKit, system-call-audio.ios.ts).
 * Elsewhere the app starts and stops its own session.
 */
export function systemCallOwnsAudio(): Promise<boolean> {
  return Promise.resolve(false);
}
