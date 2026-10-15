# Headless mode

`dscode -p "task"` runs one non-interactive turn and exits. `--mode json`
emits JSONL events for scripting. Pair with `-C <dir>` to set the workspace.

## Environment

Everything is environment-driven, which makes scripts deterministic:

- `DSCODE_PROVIDER`, `DSCODE_MODEL`, `DSCODE_TRANSPORT`, `DSCODE_EFFORT`
- `DEEPSEEK_BASE_URL`, `DEEPSEEK_API_KEY` (credentials - env or stored)
- `DSCODE_PERMISSION` (`plan|ask|auto|full`), `DSCODE_SANDBOX`
  (`read-only|workspace-write|danger-full-access`), `--network`
- `DSCODE_HOME` to relocate `~/.dscode` (useful for test isolation)
- `DSCODE_BUDGET_USD` for a spend cap; when the cap is exceeded, inputs are
  consumed without issuing a request and the process exits 1
- `DSCODE_LEARNING_MODEL=off` / `DSCODE_COMPACTION_MODEL=off` disable
  background lanes for fully deterministic runs

## Exit codes

`0` success; `1` run failed (provider error) or a blocked input. Slash
commands are unavailable in `-p`; use flags instead.

## Sessions

Add `--resume` / `--continue` to attach to saved sessions; `--fork` branches.
Sessions persist as JSONL under `~/.dscode/sessions/YYYY/MM/DD`.

## Notes

- Goal loops and scheduled-task firing are TUI-only; headless runs a single
  turn per invocation.
- `dscode login <provider>` is interactive; scripts should use env vars.
