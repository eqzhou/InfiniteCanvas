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

test_redis_url=$(printf '%s' "$OPENBOARD_REDIS_URL" | sed -E 's#/([0-9]+)(\?.*)?$#/14\2#')

cleanup() {
  local database
  while IFS= read -r database; do
    [[ "$database" =~ ^openboard_e2e_[0-9]+_[0-9]+$ ]] || continue
    dropdb --if-exists --force "$database" >/dev/null
  done < <(psql -d postgres -X -At -c "SELECT datname FROM pg_database WHERE datname LIKE 'openboard_e2e_%'")
  redis-cli -u "$test_redis_url" FLUSHDB >/dev/null
}

trap cleanup EXIT INT TERM
cleanup
cd web
OPENBOARD_E2E_FORMAL=1 playwright test
