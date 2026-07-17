#!/usr/bin/env bash
set -euo pipefail

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

export OPENBOARD_E2E_RUN_ID="$(date +%s)_$$"
test_db="openboard_e2e_${OPENBOARD_E2E_RUN_ID}"
database_host=$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$OPENBOARD_DATABASE_URL")
test_redis_url=$(node -e '
  const value = new URL(process.argv[1]);
  if (value.protocol !== "redis:" && value.protocol !== "rediss:") process.exit(2);
  value.pathname = "/14";
  process.stdout.write(value.toString());
' "$OPENBOARD_REDIS_URL")

cleanup() {
  redis-cli -u "$test_redis_url" FLUSHDB >/dev/null 2>&1 || true
  if ! dropdb --if-exists --force --maintenance-db="$OPENBOARD_DATABASE_URL" "$test_db" >/dev/null 2>&1; then
    case "$database_host" in
      localhost|127.0.0.1|::1) dropdb --if-exists --force "$test_db" >/dev/null 2>&1 || true ;;
    esac
  fi
}
trap cleanup EXIT INT TERM

cd web
OPENBOARD_E2E_FORMAL=1 playwright test
