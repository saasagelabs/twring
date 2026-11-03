#!/usr/bin/env bash
# Creates Twring's Play upload keystore (Twring's operations notes, private). Run once; keep the result forever.
#
#   apps/mobile/scripts/create-upload-keystore.sh <directory outside the repo>
#
# Writes <dir>/upload-keystore.p12 (PKCS12, RSA 4096, 10000 days) and <dir>/upload-keystore.password
# (mode 600; store and key share it, as PKCS12 requires). The password is never printed. Prints
# the keystore path and its SHA-1/SHA-256 fingerprints (for the Google OAuth Android client).
# Then move both into your password manager.
set -euo pipefail

die() { echo "create-upload-keystore: $*" >&2; exit 1; }
ALIAS=upload

DIR="${1:-}"
[ -n "$DIR" ] || die "usage: $0 <directory outside the repo>"
command -v keytool >/dev/null || die "keytool not found (install a JDK, or add its bin/ to PATH)."
command -v openssl >/dev/null || die "openssl not found."

mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"
if REPO_ROOT="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  die "$DIR is inside a git repository ($REPO_ROOT). Choose a directory outside any repo."
fi

STORE="$DIR/upload-keystore.p12"
PASSFILE="$DIR/upload-keystore.password"
[ ! -e "$STORE" ] || die "$STORE already exists. Refusing to overwrite an upload key."
[ ! -e "$PASSFILE" ] || die "$PASSFILE already exists. Refusing to overwrite it."

umask 077
openssl rand -base64 32 | tr -d '/+=\r\n' >"$PASSFILE" # \r: Windows openssl ends lines with CRLF
chmod 600 "$PASSFILE"

# keytool reads the passwords from the environment (:env), so they never appear in argv.
CORD_KEYSTORE_PASSWORD="$(cat "$PASSFILE")" keytool -genkeypair -v \
  -storetype PKCS12 -keystore "$STORE" -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=CORD Upload Key" \
  -storepass:env CORD_KEYSTORE_PASSWORD -keypass:env CORD_KEYSTORE_PASSWORD >/dev/null 2>&1 ||
  { rm -f "$STORE" "$PASSFILE"; die "keytool failed."; }
chmod 600 "$STORE"

echo "Keystore: $STORE"
echo "Alias:    $ALIAS"
echo "Password: in $PASSFILE (not printed)"
CORD_KEYSTORE_PASSWORD="$(cat "$PASSFILE")" keytool -list -v -keystore "$STORE" -alias "$ALIAS" \
  -storepass:env CORD_KEYSTORE_PASSWORD | grep -E '^\s*SHA(1|256):'
