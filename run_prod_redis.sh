#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$ROOT_DIR/client"
SERVER_DIR="$ROOT_DIR/server"

REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
PORT="${PORT:-4000}"
VITE_API_URL="${VITE_API_URL:-}"
LOG_FILE="${LOG_FILE:-$SERVER_DIR/server.log}"

echo "Checking Redis at ${REDIS_URL}..."
if command -v redis-cli >/dev/null 2>&1; then
  if ! redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1; then
    echo "Redis is not reachable at ${REDIS_URL} (or redis-cli auth failed)." >&2
    exit 1
  fi
else
  echo "redis-cli not found; skipping reachability check."
fi

echo "Installing + building client..."
(cd "$CLIENT_DIR" && npm ci && VITE_API_URL="$VITE_API_URL" npm run build)

echo "Installing server deps..."
(cd "$SERVER_DIR" && npm ci)

echo "Starting server on port ${PORT} with Redis backend (background, logs -> ${LOG_FILE})..."
cd "$SERVER_DIR"
PORT="$PORT" REDIS_URL="$REDIS_URL" STORE_BACKEND=redis nohup npm start >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "Server PID: ${SERVER_PID}"
