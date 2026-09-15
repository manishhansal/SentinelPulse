#!/bin/sh
# SentinelPulse container entrypoint.
#
# When running as the API service (CMD = node dist/server.js):
#   1. Runs `prisma migrate deploy` — idempotent, safe to repeat.
#   2. Starts the server.
#
# When running as a worker or cron service, docker-compose overrides CMD
# with the specific worker command (e.g. node dist/workers/normalize.worker.js).
# In that case this entrypoint receives those args and just execs them directly
# WITHOUT running migrations (workers don't own the schema).

set -e

# If the first argument is "node" and the target is the server, run migrations first.
# For all other node commands (workers, crons, one-off scripts), skip migrations.
if [ "$1" = "node" ] && [ "$2" = "dist/server.js" ]; then
  echo "[entrypoint] Running Prisma migrations..."
  node_modules/.bin/prisma migrate deploy
  echo "[entrypoint] Migrations complete."
fi

echo "[entrypoint] Starting: $*"
exec "$@"
