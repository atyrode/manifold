# manifold hub image: one Bun process serving HTTP + both WS endpoints + the web
# bundle, plus an in-container PTY agent (machine ${MANIFOLD_MACHINE_NAME:-hub}).
# Debian-based oven/bun provides bash and PTY support for in-container shells.
FROM oven/bun:1 AS build
WORKDIR /app

# Full-source install: the web workspace depends on a GitHub-release tarball
# (@excalidraw/excalidraw fork) that bun links correctly only with the real
# workspace tree present — manifest-only installs leave it unlinked.
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build:web

# Runtime ships the workspace source (agent-spawn runs `bun packages/agent/src/main.ts`
# from source), the installed node_modules, and the built web bundle — no build caches.
FROM oven/bun:1
WORKDIR /app
COPY --from=build /app /app

ENV MANIFOLD_BIND=0.0.0.0 \
    MANIFOLD_DATA_DIR=/data

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:7777/healthz'); if (!r.ok) process.exit(1);"

CMD ["bun", "packages/server/src/main.ts"]
