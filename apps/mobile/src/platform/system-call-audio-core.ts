/**
 * iOS: a ring answered on the system call screen hands the audio session to CallKit. WebRTC's
 * audio engine is held off (availability none) until CallKit activates the session, then allowed
 * again; when the system call ends it is always allowed again, so a later in-app call has audio.
 *
 * Pattern from LiveKit's Swift SDK CallKit guidance
 * (https://github.com/livekit/client-sdk-swift/blob/main/README.md, "Integration with CallKit":
 * `setEngineAvailability(.none)` before, `.default` in didActivate), using the React Native
 * binding `AudioDeviceModule.setEngineAvailability`
 * (node_modules/@livekit/react-native-webrtc/src/AudioDeviceModule.ts:446).
 */
export interface SystemCallAudioDeps {
  /** Whether an answered system call owns the session, and whether CallKit activated it yet. */
  state(): Promise<{ owned: boolean; active: boolean }>;
  /** false: the engine may not start; true: back to the default (input and output). */
  setEngineAllowed(allowed: boolean): Promise<void>;
  onActivated(listener: () => void): void;
  onReleased(listener: () => void): void;
}

export interface SystemCallAudio {
  /**
   * Before a call connects: true when the system call owns the session (the app must not start
   * its own). The engine is held until CallKit activates the session.
   */
  prepare(): Promise<boolean>;
}

export function createSystemCallAudio(deps: SystemCallAudioDeps): SystemCallAudio {
  let held = false;
  let active = false;
  const allow = () => {
    if (!held) return;
    held = false;
    void deps.setEngineAllowed(true).catch(() => undefined);
  };
  deps.onActivated(() => {
    active = true;
    allow();
  });
  deps.onReleased(() => {
    active = false;
    allow();
  });
  return {
    async prepare() {
      let state: { owned: boolean; active: boolean };
      try {
        state = await deps.state();
      } catch {
        return false;
      }
      if (!state.owned) return false;
      if (state.active || active || held) return true;
      held = true;
      try {
        await deps.setEngineAllowed(false);
      } catch {
        // Could not hold the engine: the call still connects without the app activating audio.
        held = false;
      }
      return true;
    },
  };
}
