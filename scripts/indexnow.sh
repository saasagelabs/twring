#!/usr/bin/env bash
# Tells IndexNow search engines (Bing, Yandex, Seznam, Naver and others) that twring.com pages
# changed, so they crawl them again soon. Run it after scripts/deploy-site.sh publishes.
#
#   scripts/indexnow.sh                       # every page in apps/site/sitemap.xml
#   scripts/indexnow.sh https://twring.com/   # only the pages named
#
# The key is public by design: search engines check that https://twring.com/<key>.txt holds it.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST=twring.com
KEY_FILE="$(cd "$REPO/apps/site" && ls | grep -E '^[0-9a-f]{32}\.txt$' | head -1)"
[ -n "$KEY_FILE" ] || { echo "indexnow: no key file in apps/site." >&2; exit 1; }
KEY="${KEY_FILE%.txt}"

if [ "$#" -gt 0 ]; then
  URLS=("$@")
else
  mapfile -t URLS < <(grep -o '<loc>[^<]*</loc>' "$REPO/apps/site/sitemap.xml" | sed 's/<\/\?loc>//g')
fi
for url in "${URLS[@]}"; do
  [[ "$url" == "https://$HOST/"* ]] || { echo "indexnow: $url is not on https://$HOST/." >&2; exit 1; }
done

live="$(curl -fsS "https://$HOST/$KEY_FILE")" || { echo "indexnow: https://$HOST/$KEY_FILE is not published yet." >&2; exit 1; }
[ "$live" = "$KEY" ] || { echo "indexnow: the published key file does not hold the key." >&2; exit 1; }

list="$(printf '"%s",' "${URLS[@]}")"
body="{\"host\":\"$HOST\",\"key\":\"$KEY\",\"keyLocation\":\"https://$HOST/$KEY_FILE\",\"urlList\":[${list%,}]}"
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST https://api.indexnow.org/indexnow \
  -H 'Content-Type: application/json; charset=utf-8' --data "$body")"
case "$code" in
  200 | 202) echo "indexnow: sent ${#URLS[@]} page(s), answer $code." ;;
  *) echo "indexnow: the IndexNow service answered $code." >&2; exit 1 ;;
esac
