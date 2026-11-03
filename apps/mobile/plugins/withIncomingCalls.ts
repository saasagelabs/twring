import { AndroidConfig, withAndroidManifest, type ConfigPlugin } from 'expo/config-plugins.js'; // .js: Node loads this file natively (type stripping)

/** Read by modules/cord-call-service Ring.kt to build the /incoming/<id> deep link. */
export const RING_SCHEME_META = 'cord.ring.scheme';

/**
 * Incoming agent calls (Android). The permissions, the FirebaseMessagingService, and the decline
 * receiver come from the local module's own manifest (merged at build time); this adds the one
 * thing that differs per variant: the URL scheme the ring's full-screen intent opens.
 */
const withIncomingCalls: ConfigPlugin<{ scheme: string }> = (config, { scheme }) =>
  withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, RING_SCHEME_META, scheme);
    return mod;
  });

export default withIncomingCalls;
