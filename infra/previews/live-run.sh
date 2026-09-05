#!/usr/bin/env bash
set -euo pipefail
bun --watch packages/server/src/main.ts &
server=$!
bun run --cwd packages/web dev -- --port "$PREVIEW_PORT" --strictPort --host 127.0.0.1 &
vite=$!
trap 'kill "$server" "$vite" 2>/dev/null || true; wait || true' EXIT
# Restart the whole pair if either process stops; systemd also kills the control group.
wait -n "$server" "$vite"
exit 1
