# manifold hub image: one Bun process serving HTTP + both WS endpoints + the web
# bundle, plus an in-container PTY agent (machine ${MANIFOLD_MACHINE_NAME:-hub}).
# Debian-based oven/bun provides bash and PTY support for in-container shells.
FROM oven/bun:1 AS build
WORKDIR /app
ARG MANIFOLD_BUILD=dev

# Full-source install: every runtime workspace dependency (@manifold/protocol,
# @manifold/scene, @manifold/sdk) is consumed from source through `workspace:*`,
# so bun can only link them with the real workspace tree present — a
# manifest-only install leaves those symlinks dangling.
COPY . .
RUN bun install --frozen-lockfile
RUN VITE_MANIFOLD_WEB_BUILD="${MANIFOLD_BUILD}" bun run build:web

# Runtime ships the workspace source (agent-spawn runs `bun packages/agent/src/main.ts`
# from source), the installed node_modules, and the built web bundle — no build caches.
FROM oven/bun:1
WORKDIR /app
COPY --from=build /app /app

# Provenance: /healthz reports this so a running deployment is attributable to a
# tree (an unattributable image cost a multi-hour diagnosis, 2026-08-25).
ARG MANIFOLD_BUILD=dev
ENV MANIFOLD_BIND=0.0.0.0 \
    MANIFOLD_DATA_DIR=/data \
    MANIFOLD_BUILD=${MANIFOLD_BUILD}

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:7777/healthz'); if (!r.ok) process.exit(1);"

CMD ["bun", "packages/server/src/main.ts"]
