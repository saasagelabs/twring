#!/usr/bin/env bash
# Packs the agent skill (skills/twring) as twring-skill.tar.gz and, with CORD_PROD_HOST and
# CORD_PROD_KEY set, publishes it to https://twring.com/downloads/twring-skill.tar.gz.
#
#   scripts/package-skill.sh                      # build only: dist/twring-skill.tar.gz
#   CORD_PROD_HOST=ubuntu@<server> CORD_PROD_KEY=<ssh key> scripts/package-skill.sh
#
# The archive holds one folder, twring/, so it unpacks straight into an agent's skills folder.
set -euo pipefail

die() { echo "package-skill: $*" >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$ROOT/skills/twring/SKILL.md" ] || die "skills/twring/SKILL.md is missing."

OUT="$ROOT/dist/twring-skill.tar.gz"
mkdir -p "$ROOT/dist"
tar -C "$ROOT/skills" -czf "$OUT" twring
echo "Built $OUT ($(wc -c <"$OUT") bytes)"
echo "SHA-256: $(sha256sum "$OUT" | cut -d' ' -f1)"

HOST="${CORD_PROD_HOST:-}"
KEY="${CORD_PROD_KEY:-}"
[ -n "$HOST" ] || exit 0
[ -n "$KEY" ] || die "set CORD_PROD_KEY with CORD_PROD_HOST."

ssh -i "$KEY" -o BatchMode=yes "$HOST" 'set -e
  tmp=$(mktemp)
  cat >"$tmp"
  sudo install -m 644 -o root -g root "$tmp" /var/www/cord-downloads/twring-skill.tar.gz
  rm -f "$tmp"' <"$OUT"

URL="${CORD_SITE_URL:-https://twring.com}/downloads/twring-skill.tar.gz"
curl -fsS "$URL" | cmp -s - "$OUT" || die "$URL does not match the built archive."
echo "Published $URL"
