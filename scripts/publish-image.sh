#!/usr/bin/env bash
# Builds the Twring server image for linux/amd64 and linux/arm64, pushes it to
# ghcr.io/saasagelabs/twring:<version>, then records its digest in
# apps/site/selfhost/versions.json (images.<version>, images.<major>, images.latest) for the next
# site deploy (scripts/deploy-site.sh).
#
#   GHCR_TOKEN_FILE=/path/to/token scripts/publish-image.sh <version>
#
# Run on a Linux machine with Docker buildx (and QEMU for the other architecture). The token is
# read from the file and handed to docker on stdin; it is never echoed or put on a command line.
# Refuses a dirty working tree (a published version is always a commit) and a version that is
# already published or recorded.
set -euo pipefail

repo=ghcr.io/saasagelabs/twring
user=saasagelabs
version=${1:-}
root=$(cd "$(dirname "$0")/.." && pwd)
versions="$root/apps/site/selfhost/versions.json"

if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo 'Usage: GHCR_TOKEN_FILE=<file> scripts/publish-image.sh <major.minor.patch>' >&2
  exit 2
fi
if [[ -z "${GHCR_TOKEN_FILE:-}" || ! -r "$GHCR_TOKEN_FILE" ]]; then
  echo 'GHCR_TOKEN_FILE must name a readable file holding the GHCR token.' >&2
  exit 2
fi
if [[ -n "$(git -C "$root" status --porcelain)" ]]; then
  echo 'The working tree has changes. Commit or stash them first.' >&2
  exit 2
fi
command -v docker >/dev/null || { echo 'Docker is not installed.' >&2; exit 2; }
docker buildx version >/dev/null || { echo 'Docker buildx is not available.' >&2; exit 2; }
command -v node >/dev/null || { echo 'Node is needed to update versions.json.' >&2; exit 2; }

# versions.json (format: deploy/selfhost/versions.ts): only a missing file counts as empty; a
# malformed one, or this version already recorded, stops the publish.
versions_tool="$root/deploy/selfhost/versions.ts"
node "$versions_tool" check "$versions" "$version" || exit 2

metadata=$(mktemp)
cleanup() {
  rm -f "$metadata"
  docker logout ghcr.io >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker login ghcr.io --username "$user" --password-stdin <"$GHCR_TOKEN_FILE" >/dev/null

if docker buildx imagetools inspect "$repo:$version" >/dev/null 2>&1; then
  echo "$repo:$version is already published. Pick a new version." >&2
  exit 2
fi

# Multi-platform builds need the docker-container driver; the default docker driver cannot.
builder=twring-publish
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container >/dev/null
fi
docker buildx inspect "$builder" --bootstrap >/dev/null

echo "Building and pushing $repo:$version (linux/amd64, linux/arm64)."
docker buildx build \
  --builder "$builder" \
  --platform linux/amd64,linux/arm64 \
  --file "$root/apps/gateway/Dockerfile" \
  --build-arg "TWRING_VERSION=$version" \
  --label "org.opencontainers.image.source=https://github.com/saasagelabs/twring" \
  --label "org.opencontainers.image.version=$version" \
  --label "org.opencontainers.image.revision=$(git -C "$root" rev-parse HEAD)" \
  --tag "$repo:$version" \
  --metadata-file "$metadata" \
  --push \
  "$root"

digest=$(node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(m["containerimage.digest"] ?? "")' "$metadata")
if ! printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  echo 'buildx did not report the image digest.' >&2
  exit 1
fi

mkdir -p "$(dirname "$versions")"
# Adds the version, recomputes images.latest and images.<major> (highest semver), keeps kit and
# connect.
node "$versions_tool" record "$versions" "$version" "$digest"

echo "Pushed $repo:$version as $digest."
echo "Recorded in apps/site/selfhost/versions.json; commit it and deploy the site."
