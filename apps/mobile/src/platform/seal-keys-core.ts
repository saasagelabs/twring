/** A phone's per-server seal keys, held by the native side so rings and messages can be opened. */
export interface SealKeys {
  set(serverId: string, keyB64url: string): Promise<void>;
  remove(serverId: string): Promise<void>;
  /** True when the native seal code works (or there is none to test). */
  selfTest(): Promise<boolean>;
}

/** The native functions (modules/cord-call-service); each is added by a later task, so optional. */
export interface SealNative {
  setSealKey?: (serverId: string, keyB64url: string) => Promise<void> | void;
  removeSealKey?: (serverId: string) => Promise<void> | void;
  sealSelfTest?: () => Promise<boolean> | boolean;
}

/** A native function that is not there yet is a no-op, so builds without it keep working. */
export function createSealKeys(native: SealNative | null | undefined): SealKeys {
  return {
    async set(serverId, keyB64url) {
      if (typeof native?.setSealKey === 'function') await native.setSealKey(serverId, keyB64url);
    },
    async remove(serverId) {
      if (typeof native?.removeSealKey === 'function') await native.removeSealKey(serverId);
    },
    async selfTest() {
      if (typeof native?.sealSelfTest !== 'function') return true;
      return (await native.sealSelfTest()) === true;
    },
  };
}
