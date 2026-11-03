#!/usr/bin/env bash
# Self-host smoke test for a fresh Linux machine with Docker and Docker Compose: builds the server
# image, renders deploy/selfhost/compose.own.yml with fake keys, starts it and waits for the server
# to answer /health/live inside its container. Tears everything down (volumes too) on exit.
#
#   scripts/selfhost-smoke.sh
#
# Fake keys only: nothing here reaches a real provider or the relay. Ports 80, 443, 7881 and 7882
# must be free on the machine.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
image=twring-smoke:local
project=twring-smoke

cleanup() {
  if [[ -f "$work/compose.yml" ]]; then
    docker compose --project-name "$project" --project-directory "$work" \
      --env-file "$work/twring.env" -f "$work/compose.yml" down --volumes >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

echo '1. Building the image.'
docker build --quiet --file "$root/apps/gateway/Dockerfile" --tag "$image" "$root" >/dev/null
if ! docker run --rm --entrypoint test "$image" -s /etc/ssl/certs/ca-certificates.crt; then
  echo 'FAIL: the image has no CA certificates (call audio over wss:// would fail).'
  exit 1
fi
echo 'PASS: the image has CA certificates.'

echo '2. Rendering the own-audio compose file with fake keys.'
# Its own private network (the installer picks a free one), so it never clashes with an install.
net=172.31.249
sed -e "s|{{TWRING_IMAGE}}|$image|g" -e 's|{{ADDRESS}}|127-0-0-1.sslip.io|g' -e 's|{{AUDIO}}|own|g' \
  -e "s|{{SUBNET}}|$net.0/24|g" -e "s|{{CADDY_IP}}|$net.2|g" -e "s|{{SERVER_IP}}|$net.3|g" \
  -e "s|{{LIVEKIT_IP}}|$net.4|g" "$root/deploy/selfhost/compose.own.yml" >"$work/compose.yml"
if grep -q '{{' "$work/compose.yml"; then
  echo 'FAIL: compose.own.yml has a placeholder this script does not fill:'
  grep -o '{{[A-Z_]*}}' "$work/compose.yml" | sort -u
  exit 1
fi
sed -e 's|{{ADDRESS}}|127-0-0-1.sslip.io|g' "$root/deploy/selfhost/Caddyfile.tmpl" >"$work/Caddyfile"
cp "$root/deploy/selfhost/livekit.yaml.tmpl" "$work/livekit.yaml"
docker run --rm --entrypoint node "$image" -e '
const { generateKeyPairSync } = require("node:crypto");
const { privateKey } = generateKeyPairSync("ed25519");
process.stdout.write(privateKey.export({ type: "pkcs8", format: "pem" }));
' >"$work/server-key.pem"
umask 077
cat >"$work/twring.env" <<EOF
CORD_CREDENTIALS_KEY=$(head -c 32 /dev/urandom | base64)
TWRING_ADMIN_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=')smoke
TWRING_SERVER_KEY_FILE=/run/twring/server-key.pem
TWRING_RELAY_KEY_FILE=/data/relay-key
DEEPGRAM_API_KEY=fake-deepgram-key
LIVEKIT_API_KEY=smokekey
LIVEKIT_API_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=')
EOF
chmod 644 "$work/server-key.pem"

compose() {
  docker compose --project-name "$project" --project-directory "$work" \
    --env-file "$work/twring.env" -f "$work/compose.yml" "$@"
}

echo '3. Starting the stack.'
# The server key is mounted read-only for the smoke only; the installer stores it in the volume.
cat >"$work/compose.override.yml" <<EOF
services:
  twring:
    volumes:
      - $work/server-key.pem:/run/twring/server-key.pem:ro
EOF
compose -f "$work/compose.override.yml" up --detach --quiet-pull

echo '4. Waiting for /health/live inside the server container.'
for _ in $(seq 1 30); do
  if compose exec -T twring node -e "fetch('http://127.0.0.1:8080/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
    echo 'PASS: the server answers /health/live.'
    compose exec -T twring sh -c 'id -u' | grep -qx 10001 || { echo 'FAIL: not running as uid 10001.'; exit 1; }
    echo 'PASS: the server runs as uid 10001.'
    # Published means a real host port: Compose answers ":0" (and success) for a port the image
    # only declares.
    published() {
      out=$(compose port twring "$1" 2>/dev/null) || return 1
      case $out in '' | *:0) return 1 ;; *) return 0 ;; esac
    }
    if published 8081 || published 8080; then
      echo 'FAIL: 8080 or 8081 is published.'
      exit 1
    fi
    echo 'PASS: 8080 and 8081 are not published.'
    exit 0
  fi
  sleep 2
done
echo 'FAIL: /health/live did not answer within 60 seconds. Server logs:'
compose logs --no-color --tail 50 twring
exit 1
