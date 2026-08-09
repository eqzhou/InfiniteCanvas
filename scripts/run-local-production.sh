#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing $ROOT/.env. Create it from .env.example first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

for name in OPENBOARD_DATABASE_URL OPENBOARD_REDIS_URL OPENBOARD_MASTER_KEY OPENBOARD_TOKEN; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required in $ROOT/.env" >&2
    exit 1
  fi
done

# This command prints only two safely quoted exports. A missing tool clears
# both paths and leaves the rest of the build/start flow available.
eval "$(node scripts/diagnose-media-capabilities.cjs --shell)"

export OPENBOARD_ADDR=127.0.0.1:8790
export OPENBOARD_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
export OPENBOARD_API_TARGET=http://127.0.0.1:8790
export OPENBOARD_WEB_OUT_DIR=dist-local

echo "Building the local production UI with PostgreSQL-backed server storage..."
bun run --cwd web build
echo "Building the local production server..."
(cd server && GOSUMDB=sum.golang.org GOTOOLCHAIN=auto go build -trimpath -o ./bin/openboard-server ./cmd/server)

cleanup() {
  trap - EXIT INT TERM
  [[ -n "${server_pid:-}" ]] && kill "$server_pid" 2>/dev/null || true
  [[ -n "${web_pid:-}" ]] && kill "$web_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

"$ROOT/server/bin/openboard-server" &
server_pid=$!

for _ in {1..60}; do
  if curl -fsS -H "Authorization: Bearer $OPENBOARD_TOKEN" http://127.0.0.1:8790/api/health >/dev/null; then
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "OpenBoard server stopped during startup." >&2
    wait "$server_pid"
  fi
  sleep 0.5
done
curl -fsS -H "Authorization: Bearer $OPENBOARD_TOKEN" http://127.0.0.1:8790/api/health >/dev/null

(cd web && exec ./node_modules/.bin/vite preview --host 127.0.0.1 --port 5173 --strictPort --outDir dist-local) &
web_pid=$!
echo "OpenBoard is ready at http://localhost:5173/"
wait "$web_pid"
