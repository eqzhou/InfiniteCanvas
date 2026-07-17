# Claude MCP Setup

OpenBoard exposes a standard stdio MCP server. This release does not embed or automate a Claude web session.

1. Build the binaries with `./install.sh --no-open`.
2. Start the OpenBoard local server once so it creates the owner-only `connection.json` file.
3. Configure your Claude MCP client to launch:

```json
{
  "mcpServers": {
    "openboard": {
      "command": "~/.local/share/openboard/bin/openboard-mcp",
      "env": {
        "OPENBOARD_CONNECTION_FILE": "~/Library/Application Support/OpenBoard/data/connection.json"
      }
    }
  }
}
```

On Linux, the default connection file is `${XDG_CONFIG_HOME:-~/.config}/OpenBoard/data/connection.json`. Keep its permissions at `0600`. The MCP server exposes OpenBoard tools only; do not add shell or unrestricted filesystem permissions for this integration.
