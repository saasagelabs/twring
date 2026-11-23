import { requireOptionalNativeModule } from 'expo';

const native = requireOptionalNativeModule<{ ownsCallAudio?(): Promise<boolean> }>('CordRing');

/**
 * iOS: a ring answered on the system call screen hands the audio session to CallKit, which
 * activates it (CordRing.swift enables WebRTC audio in didActivate). The app must not activate it
 * itself first. A missing or old native module means the app starts its own session as before.
 */
export async function systemCallOwnsAudio(): Promise<boolean> {
  try {
    return (await native?.ownsCallAudio?.()) ?? false;
  } catch {
    return false;
  }
}
