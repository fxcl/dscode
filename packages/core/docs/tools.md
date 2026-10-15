# Tools

Core tools available to the model (names are exact):

- `exec_command` - run a shell command in the managed sandbox. Long-running
  commands return a `process_id`; drive with `write_stdin`. Output above the
  context guard is withheld with a notice.
- `apply_patch` - the only file-mutation path. Atomic, workspace-confined,
  creates a checkpoint per successful patch. Patch format: `*** Begin Patch`
  ... `*** End Patch` with `Add File` / `Update File` / `Delete File` /
  `Move to` sections.
- `write_stdin` - write to / poll / terminate a managed process.
- `update_plan` - publish the structured plan shown in the UI (up to 30
  steps, one in_progress).
- `delegate` - run a sub-agent (explorer / implementer / reviewer / verifier
  / writer and research roles) in a separate worktree or read-only sandbox.
- `schedule_create` / `schedule_list` / `schedule_cancel` - persistent
  background prompts (interval or five-field cron). Fired in TUI sessions;
  missed one-shots ask before running.
- `web_search` - server-side or client search depending on configuration.
- `dscode_knowledge` - read DSCode's own reference docs (this directory).
- `mcp__<server>__<tool>` - tools from configured MCP servers.

## Input repair

Mis-named or mis-typed arguments are repaired in place when the intent is
unambiguous: aliased names (e.g. `command` -> `cmd`, `pid` -> `process_id`)
are renamed, numeric/boolean strings are coerced, markdown link wrappers are
unwrapped, and unknown fields are dropped. Each repair is announced so it is
visible rather than silent.

## Concurrency

`exec_command` and `apply_patch` run sequentially (they mutate shared
state); independent read-only tools run in parallel.
