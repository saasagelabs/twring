import type { ConfigContext, ExpoConfig } from 'expo/config';

import withIncomingCalls from './plugins/withIncomingCalls.ts';
import withReleaseSigning from './plugins/withReleaseSigning.ts';

/**
 * The user-visible app name: Twring. CORD was the project codename; live IDs below (schemes, slug) still use it.
 * Change it here (or set CORD_APP_NAME at build time). Dev/staging append a suffix. (Twring's operations notes, private).
 */
const BRAND_NAME = process.env.CORD_APP_NAME?.trim() || 'Twring';

/** Semver shown to users. Bump for each store release. */
const VERSION_NAME = '0.1.0';

/**
 * APP_VARIANT selects the installable identity so development, staging, and production builds
 * can coexist on one device. It is a build-time switch, separate from EXPO_PUBLIC_CORD_ENV
 * (which backend the JS talks to). EAS profiles set both: see eas.json.
 */
type AppVariant = 'development' | 'staging' | 'production';

function readVariant(value: string | undefined): AppVariant {
  switch (value) {
    case undefined:
    case '':
    case 'development':
      return 'development';
    case 'staging':
    case 'production':
      return value;
    default:
      throw new Error(`Unknown APP_VARIANT "${value}". Use development, staging, or production.`);
  }
}

const variant = readVariant(process.env.APP_VARIANT);

const MICROPHONE_USAGE = `${BRAND_NAME} uses the microphone so you can talk to your agent during a call or record a voice note.`;

const CAMERA_USAGE = `${BRAND_NAME} uses the camera to scan a link code or take a photo to send to your agent.`;

// Permanent once uploaded to Play: a package ID can never change or be reused (Twring's operations notes, private).
const BASE_ID = 'com.twring.app';

const identity: Record<AppVariant, { name: string; id: string; scheme: string }> = {
  development: { name: `${BRAND_NAME} Dev`, id: `${BASE_ID}.dev`, scheme: 'cord-dev' },
  staging: { name: `${BRAND_NAME} Staging`, id: `${BASE_ID}.staging`, scheme: 'cord-staging' },
  production: { name: BRAND_NAME, id: BASE_ID, scheme: 'cord' },
};

/**
 * Google Sign-In's iOS URL scheme is the iOS OAuth client id reversed. The plugin refuses to run
 * without one, so it is only added once that client exists; Android needs no plugin options
 * (autolinking installs the native module either way).
 */
function googleSignInPlugin(): [string, { iosUrlScheme: string }] | undefined {
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim();
  if (!iosClientId) return undefined;
  const suffix = '.apps.googleusercontent.com';
  const id = iosClientId.endsWith(suffix) ? iosClientId.slice(0, -suffix.length) : iosClientId;
  return [
    '@react-native-google-signin/google-signin',
    { iosUrlScheme: `com.googleusercontent.apps.${id}` },
  ];
}

/**
 * Android versionCode: CORD_VERSION_CODE (CI build number) or 1 for local builds. It must rise
 * with every Play upload and is never reused, so only CI builds are uploaded. (Twring's operations notes, private).
 */
function readVersionCode(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 1;
  const code = Number(value);
  if (!Number.isInteger(code) || code < 1 || code > 2_100_000_000) {
    throw new Error(`CORD_VERSION_CODE must be an integer from 1 to 2100000000, got "${value}".`);
  }
  return code;
}

/** TestFlight uploads of the same version need rising build numbers; Codemagic supplies BUILD_NUMBER. */
function readIosBuildNumber(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return '1';
  const code = Number(value);
  if (!Number.isInteger(code) || code < 1 || code > 2_100_000_000) {
    throw new Error(
      `CORD_IOS_BUILD_NUMBER must be an integer from 1 to 2100000000, got "${value}".`,
    );
  }
  return String(code);
}

/**
 * Firebase config for FCM (incoming agent calls). A path from the environment, never committed:
 * the owner keeps it at %USERPROFILE%/.cord/google-services.json (project cord-push, which covers
 * all three variants); EAS reads it from a file secret. Without it the build still works, but
 * agents cannot ring this phone.
 */
function googleServicesFile(): string | undefined {
  const file = process.env.CORD_GOOGLE_SERVICES_FILE?.trim();
  return file === undefined || file === '' ? undefined : file;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const { name, id, scheme } = identity[variant];
  const googleSignIn = googleSignInPlugin();
  const expoConfig: ExpoConfig = {
    ...config,
    name,
    slug: 'cord',
    version: VERSION_NAME,
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    // Production also opens twring://pair links from a self-hosted server.
    scheme: variant === 'production' ? [scheme, 'twring'] : scheme,
    userInterfaceStyle: 'dark',
    backgroundColor: '#000000',
    ios: {
      bundleIdentifier: id,
      buildNumber: readIosBuildNumber(process.env.CORD_IOS_BUILD_NUMBER),
      supportsTablet: false,
      // Sign in with Apple: App Store guideline 4.8.
      usesAppleSignIn: true,
      // Expo writes this into PrivacyInfo.xcprivacy at prebuild. After an upload, Apple emails any
      // reason still missing (https://docs.expo.dev/guides/apple-privacy/).
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyAccessedAPITypes: [
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
            NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
            NSPrivacyAccessedAPITypeReasons: ['C617.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
            NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
            NSPrivacyAccessedAPITypeReasons: ['E174.1'],
          },
        ],
      },
      infoPlist: {
        // Required by Apple before any microphone access.
        NSMicrophoneUsageDescription: MICROPHONE_USAGE,
        ITSAppUsesNonExemptEncryption: false,
        // audio: a live call keeps running with the screen locked (ADR-019). voip: agents ring the
        // iPhone through PushKit and CallKit. remote-notification: a ring that ends elsewhere
        // closes the call screen.
        UIBackgroundModes: ['audio', 'voip', 'remote-notification'],
      },
      // APNs for rings and notifications. Store and TestFlight builds use production APNs.
      entitlements: {
        'aps-environment': variant === 'production' ? 'production' : 'development',
      },
    },
    android: {
      package: id,
      ...(googleServicesFile() !== undefined && { googleServicesFile: googleServicesFile() }),
      versionCode: readVersionCode(process.env.CORD_VERSION_CODE),
      adaptiveIcon: {
        backgroundColor: '#000000',
        foregroundImage: './assets/images/android-icon-foreground.png',
        backgroundImage: './assets/images/android-icon-background.png',
        monochromeImage: './assets/images/android-icon-monochrome.png',
      },
      // Android back during a call must not silently destroy the session (MOBILE_PLATFORM_SPEC §10);
      // keep predictive back off until call screens handle it explicitly.
      predictiveBackGestureEnabled: false,
      // The WebRTC plugin requests this for video calling; Twring is audio-only, and unused
      // permissions would have to be declared in the Play data-safety form. The camera scans
      // a computer's link code (ADR-025) and takes photos for chat.
      blockedPermissions: ['android.permission.SYSTEM_ALERT_WINDOW'],
    },
    plugins: [
      'expo-router',
      'expo-dev-client',
      'expo-font',
      // Sign-in session storage (Keychain / Android Keystore). ADR-021.
      'expo-secure-store',
      [
        'expo-image-picker',
        {
          photosPermission: `${BRAND_NAME} opens your photos so you can send one to your agent.`,
          cameraPermission: CAMERA_USAGE,
          // Never false: on Android that blocks RECORD_AUDIO for the whole app, and calls go silent.
          microphonePermission: MICROPHONE_USAGE,
        },
      ],
      ...(googleSignIn === undefined ? [] : [googleSignIn]),
      // LiveKit native audio. "communication" = voice-call audio mode with echo cancellation.
      ['@livekit/react-native-expo-plugin', { android: { audioType: 'communication' } }],
      [
        '@config-plugins/react-native-webrtc',
        {
          microphonePermission: MICROPHONE_USAGE,
          // Same purpose string as expo-camera and the photo picker.
          cameraPermission: CAMERA_USAGE,
        },
      ],
      // Scans the QR code `npx cord-connect` shows (ADR-025). No video recording, so no audio.
      [
        'expo-camera',
        {
          cameraPermission: CAMERA_USAGE,
          recordAudioAndroid: false,
          barcodeScannerEnabled: true,
        },
      ],
      [
        'expo-splash-screen',
        {
          backgroundColor: '#000000',
          image: './assets/images/splash-icon.png',
          imageWidth: 76,
        },
      ],
      [
        '@sentry/react-native/expo',
        {
          organization: process.env.SENTRY_ORG,
          project: process.env.SENTRY_PROJECT,
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      appVariant: variant,
    },
  };
  const withRing = withIncomingCalls(expoConfig, { scheme });
  // Upload-key signing for production releases only; fails closed without the key.
  return variant === 'production' ? withReleaseSigning(withRing) : withRing;
};
