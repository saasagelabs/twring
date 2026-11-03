// Typed environment variables. Expo's ambient ProcessEnv is an `any` index signature; naming the
// variables here keeps reads type-safe. EXPO_PUBLIC_* are inlined into the JS bundle (public);
// the rest are read only by app.config.ts at build time.
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      EXPO_PUBLIC_CORD_ENV?: string;
      EXPO_PUBLIC_API_BASE_URL?: string;
      EXPO_PUBLIC_LIVEKIT_PUBLIC_URL?: string;
      EXPO_PUBLIC_RELAY_URL?: string;
      EXPO_PUBLIC_SENTRY_DSN?: string;
      EXPO_PUBLIC_SUPABASE_URL?: string;
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
      EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?: string;
      EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?: string;
      APP_VARIANT?: string;
      SENTRY_ORG?: string;
      SENTRY_PROJECT?: string;
      CORD_APP_NAME?: string;
      CORD_GOOGLE_SERVICES_FILE?: string;
      CORD_VERSION_CODE?: string;
      CORD_IOS_BUILD_NUMBER?: string;
    }
  }
}

export {};
