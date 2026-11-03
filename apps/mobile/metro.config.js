// Expo's default Metro config (monorepo-aware since SDK 52) wrapped by Sentry so bundles carry
// debug IDs that match uploaded source maps. Metro loads this file as CommonJS.
/* eslint-disable @typescript-eslint/no-require-imports */
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

module.exports = getSentryExpoConfig(__dirname);
