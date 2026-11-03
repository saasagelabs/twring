#!/usr/bin/env bash
# The TestFlight build, step by step, for .github/workflows/ios-testflight.yml (macOS runner).
#   bash apps/mobile/scripts/ios-testflight.sh <check-env|setup-signing|build-number|prebuild|archive|upload|cleanup>
# Run from the repository root. Secrets come from the environment and are never printed.
set -euo pipefail

SECRETS=(ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8_BASE64 IOS_DIST_CERT_P12_BASE64 IOS_DIST_CERT_PASSWORD
  IOS_APPSTORE_PROFILE_BASE64 EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID EXPO_PUBLIC_SENTRY_DSN)
APP_ID=6824735840
BUNDLE_ID=com.twring.app
WORK="${RUNNER_TEMP:-/tmp}/ios-signing"

check_env() {
  local missing=()
  for name in "${SECRETS[@]}"; do [ -n "${!name:-}" ] || missing+=("$name"); done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "Missing secrets in the testflight environment: ${missing[*]}" >&2
    exit 1
  fi
  echo "All ${#SECRETS[@]} secrets are set."
}

setup_signing() {
  mkdir -p "$WORK" && chmod 700 "$WORK"
  printf %s "$IOS_DIST_CERT_P12_BASE64" | base64 --decode >"$WORK/dist.p12"
  printf %s "$IOS_APPSTORE_PROFILE_BASE64" | base64 --decode >"$WORK/appstore.mobileprovision"
  printf %s "$ASC_KEY_P8_BASE64" | base64 --decode >"$WORK/AuthKey.p8"
  local keychain="$WORK/build.keychain-db" pass
  pass="$(openssl rand -hex 24)"
  security create-keychain -p "$pass" "$keychain"
  security set-keychain-settings -lut 3600 "$keychain"
  security unlock-keychain -p "$pass" "$keychain"
  security import "$WORK/dist.p12" -k "$keychain" -P "$IOS_DIST_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
  security set-key-partition-list -S apple-tool:,apple: -s -k "$pass" "$keychain" >/dev/null
  # Search the build keychain first, then the existing ones.
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
  security cms -D -i "$WORK/appstore.mobileprovision" >"$WORK/profile.plist"
  local uuid name team
  uuid=$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$WORK/profile.plist")
  name=$(/usr/libexec/PlistBuddy -c 'Print :Name' "$WORK/profile.plist")
  team=$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$WORK/profile.plist")
  for dir in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
    mkdir -p "$dir" && cp "$WORK/appstore.mobileprovision" "$dir/$uuid.mobileprovision"
  done
  {
    echo "IOS_TEAM_ID=$team"
    echo "IOS_PROFILE_UUID=$uuid"
    echo "IOS_PROFILE_NAME=$name"
    echo "IOS_KEYCHAIN=$keychain"
    echo "ASC_KEY_P8_PATH=$WORK/AuthKey.p8"
  } >>"${GITHUB_ENV:?}"
  echo "Signing ready: team $team, profile \"$name\"."
}

build_number() {
  local n
  n=$(ASC_APP_ID="$APP_ID" node apps/mobile/scripts/next-ios-build-number.mjs)
  echo "IOS_BUILD_NUMBER=$n" >>"${GITHUB_ENV:?}"
  echo "Next build number: $n"
}

prebuild() {
  (cd apps/mobile && CORD_IOS_BUILD_NUMBER="${IOS_BUILD_NUMBER:?}" pnpm exec expo prebuild --platform ios --clean)
}

archive() {
  cd apps/mobile/ios
  shopt -s nullglob
  local workspaces=(*.xcworkspace) projects=(*.xcodeproj)
  [ "${#workspaces[@]}" -gt 0 ] || {
    echo "expo prebuild did not generate an .xcworkspace" >&2
    exit 1
  }
  local workspace="${workspaces[0]}" scheme
  scheme="$(basename "$workspace" .xcworkspace)"
  # Manual signing on the app target only (Pods targets stay unsigned).
  IOS_PROJECT="${projects[0]}" ruby -rxcodeproj -e '
    project = Xcodeproj::Project.open(ENV.fetch("IOS_PROJECT"))
    project.targets.select { |t| t.product_type == "com.apple.product-type.application" }.each do |t|
      t.build_configurations.each do |c|
        s = c.build_settings
        s["CODE_SIGN_STYLE"] = "Manual"
        s["DEVELOPMENT_TEAM"] = ENV.fetch("IOS_TEAM_ID")
        s["CODE_SIGN_IDENTITY"] = "Apple Distribution"
        s["CODE_SIGN_IDENTITY[sdk=iphoneos*]"] = "Apple Distribution"
        s["PROVISIONING_PROFILE_SPECIFIER"] = ENV.fetch("IOS_PROFILE_NAME")
      end
    end
    project.save'
  xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release -sdk iphoneos \
    -destination 'generic/platform=iOS' -archivePath "$RUNNER_TEMP/Twring.xcarchive" \
    OTHER_CODE_SIGN_FLAGS="--keychain $IOS_KEYCHAIN" archive
  cat >"$RUNNER_TEMP/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>${IOS_TEAM_ID}</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>${IOS_PROFILE_NAME}</string></dict>
</dict></plist>
PLIST
  xcodebuild -exportArchive -archivePath "$RUNNER_TEMP/Twring.xcarchive" \
    -exportOptionsPlist "$RUNNER_TEMP/ExportOptions.plist" -exportPath "$RUNNER_TEMP/ios-export"
  ls "$RUNNER_TEMP/ios-export"/*.ipa >/dev/null
}

upload() {
  local ipa
  ipa=$(ls "$RUNNER_TEMP/ios-export"/*.ipa | head -1)
  mkdir -p "$HOME/.appstoreconnect/private_keys"
  cp "${ASC_KEY_P8_PATH:?}" "$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
  if xcrun --find altool >/dev/null 2>&1; then
    xcrun altool --upload-app --type ios --file "$ipa" --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  else
    node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({key_id:process.env.ASC_KEY_ID,issuer_id:process.env.ASC_ISSUER_ID,key:fs.readFileSync(process.env.ASC_KEY_P8_PATH,"utf8")}),{mode:0o600})' "$WORK/asc-key.json"
    fastlane run upload_to_testflight ipa:"$ipa" api_key_path:"$WORK/asc-key.json" \
      skip_waiting_for_build_processing:true skip_submission:true
  fi
  echo "Uploaded build ${IOS_BUILD_NUMBER:-?} to App Store Connect."
}

cleanup() {
  if [ -n "${IOS_KEYCHAIN:-}" ]; then security delete-keychain "$IOS_KEYCHAIN" 2>/dev/null || true; fi
  rm -rf "$WORK" "$HOME/.appstoreconnect/private_keys" \
    "$HOME/Library/MobileDevice/Provisioning Profiles/${IOS_PROFILE_UUID:-none}.mobileprovision" \
    "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/${IOS_PROFILE_UUID:-none}.mobileprovision"
  echo "Signing material removed."
}

case "${1:-}" in
  check-env) check_env ;;
  setup-signing) setup_signing ;;
  build-number) build_number ;;
  prebuild) prebuild ;;
  archive) archive ;;
  upload) upload ;;
  cleanup) cleanup ;;
  *)
    echo "Usage: ios-testflight.sh <check-env|setup-signing|build-number|prebuild|archive|upload|cleanup>" >&2
    exit 2
    ;;
esac
