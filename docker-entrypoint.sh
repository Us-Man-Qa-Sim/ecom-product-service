#!/bin/sh
# PRD-3: build/update MongoDB indexes before the service starts.
# Production runs with `autoIndex: false`, so schema indexes are driven
# explicitly here. `syncIndexes()` is idempotent — a fresh DB gets the full
# index set, a warm DB is a no-op — and we fail fast rather than serve queries
# against missing indexes.
# `exec` replaces the shell so Node becomes PID 1 and receives SIGTERM directly
# for graceful shutdown.
set -e

echo "[entrypoint] syncing MongoDB indexes..."
node dist/scripts/sync-indexes.js

echo "[entrypoint] starting product-service..."
exec node dist/main.js
