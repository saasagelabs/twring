import { createSealKeys, type SealKeys } from './seal-keys-core';

export type { SealKeys } from './seal-keys-core';

/** Web and tests: no native seal code, so every call is a no-op (android and ios override this). */
export const sealKeys: SealKeys = createSealKeys(null);
