#!/usr/bin/env bash
set -euo pipefail

PORT=${1:?server port is required}
ORIGIN=${2:?web origin is required}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

for name in OPENBOARD_DATABASE_URL OPENBOARD_REDIS_URL OPENBOARD_MASTER_KEY; do
  [[ -n "${!name:-}" ]] || { echo "$name is required" >&2; exit 1; }
done

suffix=${OPENBOARD_E2E_RUN_ID:?formal E2E run id is required}
[[ "$suffix" =~ ^[0-9]+_[0-9]+$ ]] || { echo "Invalid formal E2E run id" >&2; exit 1; }
test_db="openboard_e2e_${suffix}"
database_base=${OPENBOARD_DATABASE_URL%%\?*}
database_query=""
[[ "$OPENBOARD_DATABASE_URL" == *\?* ]] && database_query="?${OPENBOARD_DATABASE_URL#*\?}"
database_server=${database_base%/*}
test_database_url="${database_server}/${test_db}${database_query}"
database_host=$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$OPENBOARD_DATABASE_URL")
database_user=$(node -e 'process.stdout.write(decodeURIComponent(new URL(process.argv[1]).username))' "$OPENBOARD_DATABASE_URL")
test_redis_url=$(node -e '
  const value = new URL(process.argv[1]);
  if (value.protocol !== "redis:" && value.protocol !== "rediss:") process.exit(2);
  value.pathname = "/14";
  process.stdout.write(value.toString());
' "$OPENBOARD_REDIS_URL")
data_dir=$(mktemp -d "${TMPDIR:-/tmp}/openboard-e2e-formal.XXXXXX")

cleanup() {
  trap - EXIT INT TERM
  [[ -n "${server_pid:-}" ]] && kill "$server_pid" 2>/dev/null || true
  [[ -n "${server_pid:-}" ]] && wait "$server_pid" 2>/dev/null || true
  redis-cli -u "$test_redis_url" FLUSHDB >/dev/null 2>&1 || true
  if ! dropdb --if-exists --force --maintenance-db="$OPENBOARD_DATABASE_URL" "$test_db" >/dev/null 2>&1; then
    case "$database_host" in
      localhost|127.0.0.1|::1) dropdb --if-exists --force "$test_db" >/dev/null 2>&1 || true ;;
    esac
  fi
  rm -rf "$data_dir"
}
trap cleanup EXIT INT TERM

if ! createdb --maintenance-db="$OPENBOARD_DATABASE_URL" "$test_db"; then
  case "$database_host" in
    localhost|127.0.0.1|::1)
      [[ -n "$database_user" ]] || { echo "Database URL must include a role for local test ownership" >&2; exit 1; }
      createdb --owner="$database_user" "$test_db"
      ;;
    *)
      echo "Database role cannot create an isolated E2E database; refusing an admin fallback for a non-loopback host" >&2
      exit 1
      ;;
  esac
fi
redis-cli -u "$test_redis_url" FLUSHDB >/dev/null

export OPENBOARD_ADDR="127.0.0.1:$PORT"
export OPENBOARD_ORIGINS="$ORIGIN"
export OPENBOARD_TOKEN=e2e-token
export OPENBOARD_AUTH_MODE=off
export OPENBOARD_DATABASE_URL="$test_database_url"
export OPENBOARD_REDIS_URL="$test_redis_url"
export OPENBOARD_DATA="$data_dir"

(cd server && GOSUMDB=sum.golang.org GOTOOLCHAIN=auto go run ./cmd/server) &
server_pid=$!
wait "$server_pid"
