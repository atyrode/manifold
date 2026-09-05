# manifold hub image: one Bun process serving HTTP + both WS endpoints + the web
# bundle, plus an OPTIONAL in-container PTY agent (`MANIFOLD_SPAWN_AGENT`, machine
# ${MANIFOLD_MACHINE_NAME:-hub}). Debian-based oven/bun provides bash and PTY support
# for in-container shells. The bun tag is ADR 0001's exact pin.
FROM oven/bun:1.3.13 AS build
WORKDIR /app
# What this image IS (scripts/build-identity.ts; docs/SELF-HOST.md §Environments): the caller
# stamps a release as its tag or a development build as `<version>+<distance>.g<sha>`. Left
# empty, the build context has no `.git` to ask, so both the bundle and the server fall back
# to the packaged version as a `development` build — an unstamped image says so.
ARG MANIFOLD_VERSION=""
ARG MANIFOLD_BUILD=""
ARG MANIFOLD_CHANNEL=""

# Full-source install: every runtime workspace dependency (@manifold/protocol,
# @manifold/scene, @manifold/sdk) is consumed from source through `workspace:*`,
# so bun can only link them with the real workspace tree present — a
# manifest-only install leaves those symlinks dangling.
COPY . .
RUN bun install --frozen-lockfile
# Shell identity is a build input, independent of the deployment provider or hostname.
ARG VITE_MANIFOLD_SITE_TITLE=manifold
ARG VITE_MANIFOLD_ICON_BACKGROUND=""
RUN bun run build:web

# Runtime ships the workspace source (agent-spawn runs `bun packages/agent/src/main.ts`
# from source), the installed node_modules, and the built web bundle — no build caches.
FROM oven/bun:1.3.13
WORKDIR /app
COPY --from=build /app /app

# Litestream 0.5.16, an OPTIONAL replicator: infra/entrypoint.sh runs it only when
# MANIFOLD_REPLICA_BUCKET is set (docs/SELF-HOST.md §Replicate the database). Any
# S3-compatible store; nothing here names a provider (ADR 0022).
RUN set -eu; case "$(uname -m)" in \
      x86_64)  asset=linux-x86_64; sum=9e29112380a942e4a62ee07773684396cb8b308dc4d67e130bef41f75e937f0a ;; \
      aarch64) asset=linux-arm64;  sum=678022e4103145302598e35d37f8718392d42e153feeb1e2d4a64dd0cd3aaf10 ;; \
      *) echo "unsupported architecture $(uname -m)"; exit 1 ;; \
    esac; \
    bun -e "const r = await fetch('https://github.com/benbjohnson/litestream/releases/download/v0.5.16/litestream-0.5.16-$asset.tar.gz'); if (!r.ok) throw new Error(String(r.status)); await Bun.write('/tmp/litestream.tar.gz', r);"; \
    echo "$sum  /tmp/litestream.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream; rm /tmp/litestream.tar.gz; \
    litestream version

# Provenance: /healthz reports this so a running deployment is attributable to a
# tree (an unattributable image cost a multi-hour diagnosis, 2026-08-25).
ARG MANIFOLD_VERSION=""
ARG MANIFOLD_BUILD=""
ARG MANIFOLD_CHANNEL=""
ENV MANIFOLD_BIND=0.0.0.0 \
    MANIFOLD_DATA_DIR=/data \
    MANIFOLD_VERSION=${MANIFOLD_VERSION} \
    MANIFOLD_BUILD=${MANIFOLD_BUILD} \
    MANIFOLD_CHANNEL=${MANIFOLD_CHANNEL}

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:7777/healthz'); if (!r.ok) process.exit(1);"

CMD ["/app/infra/entrypoint.sh"]
