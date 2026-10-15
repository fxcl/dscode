# Sandbox

Commands run through `exec_command` inside an OS sandbox. Which backend is
used is resolved adaptively per platform; `/doctor` reports the active one and,
when none is available, prints a `sandbox fix:` line with the exact next step.

## Backends

- **macOS**: Seatbelt (`sandbox-exec`), automatically used when present.
- **Windows**: the native sandbox (experimental). One-time setup, then opt in:
  1. Build the helper: `pnpm build:windows-sandbox` (needs a Go toolchain;
     set `GOPROXY=https://goproxy.cn` where proxy.golang.org is unreachable).
  2. Elevated terminal: `dscode sandbox setup` (creates the isolated
     DSCodeRO*/DSCodeRW* accounts).
  3. Set `DSCODE_WINDOWS_SANDBOX=1`.
  `dscode sandbox status|uninstall` manage it. PowerShell 7 is preferred;
  the in-box Windows PowerShell 5.1 is accepted as a fallback. Note: the first
  sandboxed commands in a workspace take a while on Windows (ACL grant), and
  workspaces with huge trees are slow to grant - prefer
  `--sandbox danger-full-access` there.
- **Docker**: set `DSCODE_SANDBOX_IMAGE` to a trusted image.
- **Host**: `--sandbox danger-full-access` disables isolation. For trusted
  workspaces only.

## Modes

`read-only` and `workspace-write` (workspace plus temp dirs writable) map onto
the backends; `network` is separately granted per command. Use
`--sandbox <mode>` or `DSCODE_SANDBOX` to choose the default.

## Exit codes and output

Long-running commands return a `process_id`; poll or drive them with
`write_stdin`. Output is captured and truncated to a guard limit; oversized
tool output is withheld with a notice rather than flooding the context.
