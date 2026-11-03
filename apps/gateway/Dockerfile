# syntax=docker/dockerfile:1
# The Twring server image (self-host kit), built from the repository root:
#   docker build -f apps/gateway/Dockerfile .
# Multi-arch (linux/amd64, linux/arm64) through scripts/publish-image.sh. Every stage runs on the
# target platform so @livekit/rtc-node installs the prebuilt binary for that architecture.
#
# Entries: node dist/main.js (the server), dist/admin-cli.js (the `twring` command, through
# `docker compose exec`), dist/probe-echo.js (reachability echo), dist/check-speech-key.js
# (installer's speech key check).

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /src

# Build: the whole workspace slice the gateway needs, then esbuild bundles @twring/* packages in.
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter "@twring/gateway..." \
  && pnpm --filter @twring/gateway run build

# Production dependencies only: exactly the gateway's own dependency tree (the third-party
# packages esbuild leaves external), from the lockfile. `pnpm deploy` needs injected workspace
# packages to use the shared lockfile; that setting changes nothing else here. The hoisted
# workspace install would instead ship every app's production dependencies (Expo, React Native).
FROM base AS deps
COPY . .
RUN pnpm --config.inject-workspace-packages=true --filter @twring/gateway \
    deploy --prod --frozen-lockfile /deploy

FROM node:24-slim AS runtime
# The published version (scripts/publish-image.sh), reported by /health as the release.
ARG TWRING_VERSION=dev
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 CORD_DATA_DIR=/data CORD_RELEASE=$TWRING_VERSION
# CA roots: @livekit/rtc-node's TLS reads the system store to join wss:// rooms, and the slim
# image ships none.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 twring \
  && useradd --system --uid 10001 --gid twring --home-dir /app --shell /usr/sbin/nologin twring \
  && install -d -o twring -g twring -m 700 /data
WORKDIR /app
COPY --from=deps /deploy/node_modules ./node_modules
COPY --from=build /src/apps/gateway/package.json ./package.json
COPY --from=build /src/apps/gateway/dist ./dist
# Fails the build if a package the bundles import is missing or has no binary for this platform.
RUN --mount=type=bind,from=build,source=/src/apps/gateway/scripts/check-dist-deps.mjs,target=/tmp/check-dist-deps.mjs \
  node /tmp/check-dist-deps.mjs /app
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
