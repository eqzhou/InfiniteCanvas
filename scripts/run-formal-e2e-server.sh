#!/usr/bin/env bash
set -euo pipefail

PORT=${1:?server port is required}
ORIGIN=${2:?web origin is required}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Formal E2E requires $ROOT/.env" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

for name in OPENBOARD_DATABASE_URL OPENBOARD_REDIS_URL OPENBOARD_MASTER_KEY; do
  [[ -n "${!name:-}" ]] || { echo "$name is required" >&2; exit 1; }
done

suffix="$(date +%s)_$$"
test_db="openboard_e2e_${suffix}"
database_base=${OPENBOARD_DATABASE_URL%%\?*}
database_query=""
[[ "$OPENBOARD_DATABASE_URL" == *\?* ]] && database_query="?${OPENBOARD_DATABASE_URL#*\?}"
database_server=${database_base%/*}
test_database_url="${database_server}/${test_db}${database_query}"
database_authority=${database_server#*://}
database_user=${database_authority%%:*}
test_redis_url=$(printf '%s' "$OPENBOARD_REDIS_URL" | sed -E 's#/([0-9]+)(\?.*)?$#/14\2#')
data_dir=$(mktemp -d "${TMPDIR:-/tmp}/openboard-e2e-formal.XXXXXX")

cleanup() {
  trap - EXIT INT TERM
  [[ -n "${server_pid:-}" ]] && kill "$server_pid" 2>/dev/null || true
  [[ -n "${server_pid:-}" ]] && wait "$server_pid" 2>/dev/null || true
  redis-cli -u "$test_redis_url" FLUSHDB >/dev/null 2>&1 || true
  dropdb --if-exists --force "$test_db" >/dev/null 2>&1 || \
    dropdb --if-exists --force --maintenance-db="$OPENBOARD_DATABASE_URL" "$test_db" >/dev/null 2>&1 || true
  rm -rf "$data_dir"
}
trap cleanup EXIT INT TERM

if ! createdb --maintenance-db="$OPENBOARD_DATABASE_URL" "$test_db" 2>/dev/null; then
  createdb --owner="$database_user" "$test_db"
fi
redis-cli -u "$test_redis_url" FLUSHDB >/dev/null

export OPENBOARD_ADDR="127.0.0.1:$PORT"
export OPENBOARD_ORIGINS="$ORIGIN"
export OPENBOARD_TOKEN=e2e-token
export OPENBOARD_DATABASE_URL="$test_database_url"
export OPENBOARD_REDIS_URL="$test_redis_url"
export OPENBOARD_DATA="$data_dir"

(cd server && GOSUMDB=sum.golang.org GOTOOLCHAIN=auto go run ./cmd/server) &
server_pid=$!
wait "$server_pid"
