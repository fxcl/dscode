# Hooks

Hooks are project-configured shell commands that run at lifecycle points.
Config lives in `~/.dscode/hooks.json` (user) and
`<project>/.dscode/hooks.json` (project, trusted projects only).

```json
{
  "hooks": {
    "sessionStart": [{ "command": "node", "args": ["check.js"], "timeoutMs": 10000 }],
    "beforeTool": [],
    "afterTool": [],
    "agentEnd": []
  }
}
```

## Events

- `sessionStart` - when a session starts.
- `beforeTool` - before a tool runs; a non-zero exit blocks the call with the
  hook's stderr as the reason.
- `afterTool` - after a tool ran (receives `tool` and `isError`).
- `agentEnd` - after a run finishes; with exit 0 the hook may print
  `{"continue": true, "reason": "..."}` to ask DSCode to keep going (at most
  one continuation per turn - a hook-triggered turn cannot trigger another).

## Payload and templating

Args support `{cwd}`, `{tool}`, and `{payload}` (full JSON of the event).
Set `stopHookActive`-style guards yourself by remembering state; the payload
on `agentEnd` includes `stopHookActive` so chained continuations are refused.

## Trust and audit

First-seen hook commands require explicit trust in interactive sessions
(SHA-256 of command+args recorded in `~/.dscode/trusted-hooks.json`); in
headless runs untrusted hooks are disabled. Every execution - success,
blocked, error, or untrusted-blocked - is appended to
`~/.dscode/audit/hooks.jsonl`.
