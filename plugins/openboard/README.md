# OpenBoard Codex Plugin

This independent local plugin connects Codex to the OpenBoard browser through the OpenBoard MCP binary. It exposes only board, asset, prompt, snapshot, and site-navigation tools. It does not grant shell access, arbitrary filesystem access, or non-OpenBoard writes.

Run `./install.sh` from this directory. The installer builds the local Go binaries, registers the stdio MCP server with Codex, and opens `http://localhost:5173/`.

The MCP process reads the local server URL and token from OpenBoard's owner-only `connection.json`. Provider API keys are not present in that file and are never exposed through MCP.
