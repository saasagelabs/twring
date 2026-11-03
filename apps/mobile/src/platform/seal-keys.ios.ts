import { requireOptionalNativeModule } from 'expo';

import { createSealKeys, type SealKeys, type SealNative } from './seal-keys-core';

export type { SealKeys } from './seal-keys-core';

const native = requireOptionalNativeModule<SealNative>('CordRing');

export const sealKeys: SealKeys = createSealKeys(native);
