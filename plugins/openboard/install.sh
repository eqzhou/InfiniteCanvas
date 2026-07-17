#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$PLUGIN_DIR/../.." && pwd)
BIN_DIR="${OPENBOARD_PLUGIN_BIN_DIR:-$HOME/.local/share/openboard/bin}"

case "$(uname -s)" in
  Darwin) DEFAULT_DATA="$HOME/Library/Application Support/OpenBoard/data" ;;
  Linux) DEFAULT_DATA="${XDG_CONFIG_HOME:-$HOME/.config}/OpenBoard/data" ;;
  *) DEFAULT_DATA="$HOME/.openboard/data" ;;
esac
DATA_DIR="${OPENBOARD_DATA:-$DEFAULT_DATA}"
CONNECTION_FILE="$DATA_DIR/connection.json"

mkdir -p "$BIN_DIR"
chmod 700 "$BIN_DIR"
(
  cd "$ROOT/server"
  GOSUMDB=sum.golang.org GOTOOLCHAIN=auto go build -trimpath -o "$BIN_DIR/openboard-server" ./cmd/server
  GOSUMDB=sum.golang.org GOTOOLCHAIN=auto go build -trimpath -o "$BIN_DIR/openboard-mcp" ./cmd/mcp
)
chmod 700 "$BIN_DIR/openboard-server" "$BIN_DIR/openboard-mcp"

if codex mcp get openboard >/dev/null 2>&1; then
  codex mcp remove openboard >/dev/null
fi
codex mcp add openboard \
  --env "OPENBOARD_CONNECTION_FILE=$CONNECTION_FILE" \
  -- "$BIN_DIR/openboard-mcp"

if [[ -f "$CONNECTION_FILE" ]]; then
  chmod 600 "$CONNECTION_FILE"
else
  printf 'OpenBoard connection file will be created when the local server starts: %s\n' "$CONNECTION_FILE"
fi

if [[ "${1:-}" != "--no-open" ]]; then
  if command -v open >/dev/null 2>&1; then
    open "http://localhost:5173/"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:5173/" >/dev/null 2>&1 &
  fi
fi

printf 'OpenBoard MCP registered. Start OpenBoard at http://localhost:5173/.\n'
