#!/usr/bin/env bash
# Publishes the static site in apps/site (twring.com landing and /beta) to the production server.
#
#   CORD_PROD_HOST=ubuntu@<server> CORD_PROD_KEY=<ssh key> \
#   TWRING_SUPABASE_URL=https://<ref>.supabase.co TWRING_SUPABASE_PUBLISHABLE_KEY=<key> \
#   scripts/deploy-site.sh
#
# Pages that sign in (the OAuth consent page) carry __SUPABASE_URL__ and
# __SUPABASE_PUBLISHABLE_KEY__; they are filled in a temporary copy here, never in the repo. Both
# values are public by design (the app ships them too).
#
# Caddy serves /var/www/twring-site for https://twring.com. Files are copied
# as root-owned, world-readable; the APK itself goes to /var/www/cord-downloads separately.
#
# The self-host installer ships with the site: /install.sh (from deploy/selfhost) with
# /install.sh.sha256, and /selfhost/kit.tar.gz (the templates and the twring command, as
# install.sh unpacks them). The kit's digest and the connector's digest are recorded in
# apps/site/selfhost/versions.json; commit it. DEPLOY_SITE_CONNECTOR (required) is the release
# build's twring-connect.mjs: its digest is recorded, and after publishing the live
# /downloads/twring-connect.mjs must match it (`twring link` refuses a connector that does not).
#
# `scripts/deploy-site.sh --dry-run` builds the stage and lists it without publishing; it changes
# only the staged versions.json, never the repo's. Test seams: DEPLOY_SITE_VERSIONS (the
# versions.json to start from and, on a real run, update), DEPLOY_SITE_STAGE_OUT (keep the stage
# in <dir>/stage).
set -euo pipefail

die() { echo "deploy-site: $*" >&2; exit 1; }
DRY_RUN=0
[ "${1:-}" = --dry-run ] && DRY_RUN=1
HOST="${CORD_PROD_HOST:-}"
KEY="${CORD_PROD_KEY:-}"
URL="${CORD_SITE_URL:-https://twring.com}"
[ "$DRY_RUN" = 1 ] || { [ -n "$HOST" ] && [ -n "$KEY" ]; } || die "set CORD_PROD_HOST and CORD_PROD_KEY."

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="$REPO/apps/site"
SELFHOST="$REPO/deploy/selfhost"
VERSIONS="${DEPLOY_SITE_VERSIONS:-$SITE/selfhost/versions.json}"
[ -f "$SITE/index.html" ] || die "$SITE/index.html is missing."

if [ -n "${DEPLOY_SITE_STAGE_OUT:-}" ]; then
  STAGE="$DEPLOY_SITE_STAGE_OUT/stage"
  rm -rf "$STAGE" && mkdir -p "$STAGE"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
else
  STAGE="$(mktemp -d)"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$STAGE" "$WORK"' EXIT
fi
cp -r "$SITE"/. "$STAGE"/

# The installer, its checksum, and the kit it downloads when piped (same layout as deploy/selfhost).
hex() { sha256sum <"$1" | cut -c1-64; }
digest() { echo "sha256:$(hex "$1")"; }
cp "$SELFHOST/install.sh" "$STAGE/install.sh"
printf '%s  install.sh\n' "$(hex "$STAGE/install.sh")" >"$STAGE/install.sh.sha256"
mkdir -p "$STAGE/selfhost"
KIT_FILES=(Caddyfile.tmpl compose.own.yml compose.twring.yml livekit.yaml.tmpl twring)
tar -C "$SELFHOST" --sort=name --owner=0 --group=0 --numeric-owner \
  --mtime='2026-01-01 00:00Z' --mode='u+rwX,go+rX,go-w' -cf - "${KIT_FILES[@]}" |
  gzip -n >"$STAGE/selfhost/kit.tar.gz"
KIT_DIGEST="$(digest "$STAGE/selfhost/kit.tar.gz")"
# The connector's digest comes from the release build, never from what is live: a tampered live
# file must not get its checksum recorded.
CONNECTOR="${DEPLOY_SITE_CONNECTOR:-}"
[ -n "$CONNECTOR" ] && [ -f "$CONNECTOR" ] ||
  die "set DEPLOY_SITE_CONNECTOR to the built twring-connect.mjs of this release."
CONNECT_DIGEST="$(digest "$CONNECTOR")"
# Recorded on the staged copy; a real run then writes it back to the repo to commit.
STAGED_VERSIONS="$STAGE/selfhost/versions.json"
if [ -f "$VERSIONS" ]; then cp "$VERSIONS" "$STAGED_VERSIONS"; else rm -f "$STAGED_VERSIONS"; fi
node "$SELFHOST/versions.ts" set "$STAGED_VERSIONS" kit "$KIT_DIGEST"
node "$SELFHOST/versions.ts" set "$STAGED_VERSIONS" connect "$CONNECT_DIGEST"

if [ "$DRY_RUN" = 1 ]; then
  (cd "$STAGE" && find . -type f | sort)
  exit 0
fi
mkdir -p "$(dirname "$VERSIONS")"
cp "$STAGED_VERSIONS" "$VERSIONS"

if grep -rlqE '__SUPABASE_URL__|__SUPABASE_PUBLISHABLE_KEY__' "$STAGE"; then
  [ -n "${TWRING_SUPABASE_URL:-}" ] && [ -n "${TWRING_SUPABASE_PUBLISHABLE_KEY:-}" ] ||
    die "set TWRING_SUPABASE_URL and TWRING_SUPABASE_PUBLISHABLE_KEY (the consent page needs them)."
  [[ "$TWRING_SUPABASE_URL" == https://* ]] || die "TWRING_SUPABASE_URL must start with https://."
  grep -rlE '__SUPABASE_URL__|__SUPABASE_PUBLISHABLE_KEY__' "$STAGE" | while read -r file; do
    sed -i -e "s|__SUPABASE_URL__|${TWRING_SUPABASE_URL%/}|g" \
      -e "s|__SUPABASE_PUBLISHABLE_KEY__|${TWRING_SUPABASE_PUBLISHABLE_KEY}|g" "$file"
  done
fi

echo "Publishing $SITE to $HOST"
tar -C "$STAGE" -cf - . | ssh -i "$KEY" -o BatchMode=yes "$HOST" 'set -e
  tmp=$(mktemp -d)
  tar -x -C "$tmp"
  sudo install -d -m 755 -o root -g root /var/www/twring-site
  sudo cp -r "$tmp"/. /var/www/twring-site/
  sudo chown -R root:root /var/www/twring-site
  sudo find /var/www/twring-site -type d -exec chmod 755 {} +
  sudo find /var/www/twring-site -type f -exec chmod 644 {} +
  rm -rf "$tmp"'

for path in / /beta/ /support/ /terms/ /connector/ /oauth/consent/ /self-hosting/ /self-hosting/guide/ /install.sh /selfhost/versions.json; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$URL$path")
  [ "$code" = 200 ] || die "$URL$path answered $code after publishing."
done
live_kit="$WORK/live-kit.tar.gz"
curl -fsS --proto '=https' "$URL/selfhost/kit.tar.gz" -o "$live_kit" ||
  die "$URL/selfhost/kit.tar.gz could not be fetched after publishing."
[ "$(digest "$live_kit")" = "$KIT_DIGEST" ] ||
  die "$URL/selfhost/kit.tar.gz does not match the recorded kit digest $KIT_DIGEST."
live_connect="$WORK/live-connect.mjs"
curl -fsS --proto '=https' "$URL/downloads/twring-connect.mjs" -o "$live_connect" ||
  die "$URL/downloads/twring-connect.mjs could not be fetched after publishing."
[ "$(digest "$live_connect")" = "$CONNECT_DIGEST" ] ||
  die "$URL/downloads/twring-connect.mjs does not match the built connector ($CONNECT_DIGEST). Upload the built file, then run this again."
echo "Site is live: $URL"
