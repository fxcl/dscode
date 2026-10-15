# Permissions

Four modes, set with `/permissions <mode>`, `--permission <mode>`, or
`DSCODE_PERMISSION` (default `auto`):

- `plan` - read-only. File mutation tools are unavailable, destructive
  commands are blocked, commands run in a read-only sandbox. Use `update_plan`
  to publish a structured plan; leaving plan mode offers Execute / Stay /
  Refine.
- `ask` - every non-read tool call asks.
- `auto` (default) - reads are free; external MCP tools and commands
  classified as dangerous ask first.
- `full` - everything allowed without prompts (confirmation gate when
  enabling interactively).

## Escalation

When a command needs more than the current sandbox allows (network access, or
host filesystem outside the workspace), DSCode asks with three choices:
allow once, allow for this command for this session, or deny. Grants are
session-scoped and visible in `/permissions` and `/doctor`.

## Shell risk classification

Commands are statically classified before execution. Dangerous patterns
(`rm -rf`, `sudo`, `git reset --hard`, force checkouts, and similar) always
ask in `auto`. Shell metacharacters and absolute-path arguments downgrade a
command's classification. Raw `bash`/`run_command`/`edit`/`write` tools are
blocked entirely - use `exec_command` and `apply_patch` so every change goes
through the managed sandbox and checkpoint layer.

## Checkpoints

Every successful `apply_patch` creates a durable checkpoint (before/after
content snapshots stored as session entries). `/undo` restores the latest
one, `/rewind` restores to a chosen point with conversation/code granularity.
