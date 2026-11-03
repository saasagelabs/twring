import { requireOptionalNativeModule } from 'expo';

import { createSealKeys, type SealKeys, type SealNative } from './seal-keys-core';

export type { SealKeys } from './seal-keys-core';

const native = requireOptionalNativeModule<SealNative>('CordCallService');

export const sealKeys: SealKeys = createSealKeys(native);
