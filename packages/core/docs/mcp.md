# MCP servers

MCP servers are configured in `~/.dscode/mcp.json` (user) and
`<project>/.dscode/mcp.json` (project; loaded only when the project is
trusted). Later scopes win on name conflicts.

## Server config

```json
{
  "mcpServers": {
    "local": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": { "API_KEY": "${vault:local-key}" }
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${vault:remote-token}" }
    }
  }
}
```

stdio servers take `command`/`args`/`env`/`cwd`; HTTP servers take `url` and
`headers`. `disabled: true` skips a server.

## Value expansion

- `${ENV_VAR}` - resolved from the process environment.
- `${vault:NAME}` - resolved from the MCP vault (`/vault set NAME`,
  stored in `~/.dscode/mcp-vault.json` with 0600 permissions). Unknown
  references fail that server's connect with the list of available entries;
  secrets never enter the model context.

## Runtime

- Tool names are `mcp__<server>__<tool>`; verbose third-party descriptions are
  compressed once per server/tool on a background lane and cached on disk.
- `/mcp` shows connection state, tool counts, and per-server errors.
- Tools count as external for permissions: they ask before running in `auto`
  mode.
