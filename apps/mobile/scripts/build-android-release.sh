#!/usr/bin/env bash
# Builds a signed Android release locally (Twring's operations notes, private).
#
#   apps/mobile/scripts/build-android-release.sh staging      # APK, debug-signed, staging server
#   apps/mobile/scripts/build-android-release.sh production   # AAB, upload-key signed
#   apps/mobile/scripts/build-android-release.sh production-apk  # the same app as an installable APK
#                                                               # (the beta, shared outside Play)
#
# production and production-apk require CORD_GOOGLE_SERVICES_FILE (push), CORD_PROD_API_BASE_URL (https://) and the upload key:
#   CORD_UPLOAD_STORE_FILE, CORD_UPLOAD_STORE_PASSWORD, CORD_UPLOAD_KEY_ALIAS, CORD_UPLOAD_KEY_PASSWORD
# staging needs CORD_STAGING_API_BASE_URL (the staging server address, kept private).
# Optional: CORD_VERSION_CODE (default 1; Play uploads come from CI build numbers),
#           CORD_APP_NAME (brand name), SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT.
#
# Runs `expo prebuild --clean` (regenerates android/ for that variant), then Gradle.
set -euo pipefail

TARGET="${1:-}"
MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "build-android-release: $*" >&2; exit 1; }

# Public values only (they ship in the app); the same ones as eas.json.
SUPABASE_URL=https://gifdayffysmzskxdgmgp.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_JOl2BTQPnkT0cN4lQA3Lrw_7lZRFovX
GOOGLE_WEB_CLIENT_ID=605371988164-rtamegb6hegcll2kbu2e2i7o1udaordu.apps.googleusercontent.com

case "$TARGET" in
  staging)
    VARIANT=staging
    STAGING_API_BASE_URL="${CORD_STAGING_API_BASE_URL:?set CORD_STAGING_API_BASE_URL for staging builds}"
    API_BASE_URL="$STAGING_API_BASE_URL"
    GRADLE_TASK=':app:assembleRelease'
    ARTIFACT=android/app/build/outputs/apk/release/app-release.apk
    ;;
  production | production-apk)
    VARIANT=production
    API_BASE_URL="${CORD_PROD_API_BASE_URL:-}"
    [ -n "$API_BASE_URL" ] || die "set CORD_PROD_API_BASE_URL (e.g. https://api.example.com)."
    [[ "$API_BASE_URL" == https://* ]] || die "CORD_PROD_API_BASE_URL must start with https://."
    missing=()
    for name in CORD_UPLOAD_STORE_FILE CORD_UPLOAD_STORE_PASSWORD CORD_UPLOAD_KEY_ALIAS CORD_UPLOAD_KEY_PASSWORD; do
      [ -n "${!name:-}" ] || missing+=("$name")
    done
    [ "${#missing[@]}" -eq 0 ] || die "missing ${missing[*]} (upload key; see Twring's operations notes, private)."
    [ -f "$CORD_UPLOAD_STORE_FILE" ] || die "CORD_UPLOAD_STORE_FILE does not point to a file."
    # Without Firebase the app installs and calls out, but agents can never ring it: refuse.
    [ -n "${CORD_GOOGLE_SERVICES_FILE:-}" ] ||
      die "set CORD_GOOGLE_SERVICES_FILE (google-services.json with com.twring.app); without it agents can't ring the app."
    [ -f "$CORD_GOOGLE_SERVICES_FILE" ] || die "CORD_GOOGLE_SERVICES_FILE does not point to a file."
    grep -q '"package_name": *"com.twring.app"' "$CORD_GOOGLE_SERVICES_FILE" ||
      die "$CORD_GOOGLE_SERVICES_FILE has no Android client for com.twring.app."
    if [ "$TARGET" = production-apk ]; then
      GRADLE_TASK=':app:assembleRelease'
      ARTIFACT=android/app/build/outputs/apk/release/app-release.apk
    else
      GRADLE_TASK=':app:bundleRelease'
      ARTIFACT=android/app/build/outputs/bundle/release/app-release.aab
    fi
    ;;
  *) die "usage: $0 <staging|production|production-apk>" ;;
esac

# Exported explicitly so they win over apps/mobile/.env.local (a local dev gateway).
export APP_VARIANT="$VARIANT"
export EXPO_PUBLIC_CORD_ENV="$VARIANT"
export EXPO_PUBLIC_API_BASE_URL="$API_BASE_URL"
export EXPO_PUBLIC_SUPABASE_URL="$SUPABASE_URL"
export EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$SUPABASE_PUBLISHABLE_KEY"
export EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID="$GOOGLE_WEB_CLIENT_ID"
export CORD_VERSION_CODE="${CORD_VERSION_CODE:-1}"

if [ -n "${SENTRY_AUTH_TOKEN:-}" ] && [ -n "${SENTRY_ORG:-}" ] && [ -n "${SENTRY_PROJECT:-}" ]; then
  echo "Sentry credentials found: source maps will be uploaded."
else
  export SENTRY_DISABLE_AUTO_UPLOAD=true
fi

# Windows hints (docs/DEVELOPMENT.md): prebuild --clean deletes local.properties (sdk.dir), and
# Gradle needs a short unix-domain-socket dir outside the repo.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    [ -n "${ANDROID_HOME:-}" ] || echo "warning: ANDROID_HOME is not set (e.g. %LOCALAPPDATA%\\Android\\Sdk)." >&2
    [[ "${JAVA_TOOL_OPTIONS:-}" == *unixdomain.tmpdir* ]] ||
      echo "warning: set JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=<dir outside the repo>." >&2
    ;;
esac

# A running Metro doesn't break a release build, but it's usually a sign of a dev session whose
# android/ is about to be regenerated for another variant.
for port in 8081 8082; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "warning: something is listening on port $port (Metro?). Re-run prebuild for dev afterwards." >&2
  fi
done

cd "$MOBILE_DIR"
echo "Building $TARGET ($GRADLE_TASK), versionCode $CORD_VERSION_CODE, API $API_BASE_URL"
pnpm exec expo prebuild --platform android --clean --no-install
(cd android && ./gradlew "$GRADLE_TASK" --no-daemon)

[ -f "$ARTIFACT" ] || die "Gradle finished but $ARTIFACT is missing."
echo
echo "Artifact: $MOBILE_DIR/$ARTIFACT"
if command -v sha256sum >/dev/null; then
  echo "SHA-256:  $(sha256sum "$ARTIFACT" | cut -d' ' -f1)"
else
  echo "SHA-256:  $(shasum -a 256 "$ARTIFACT" | cut -d' ' -f1)"
fi
