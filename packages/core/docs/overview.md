# DSCode overview

DSCode is a local-first, multi-provider coding agent. The runtime is a pnpm
monorepo: `packages/core` holds the agent runtime (an extension over the pi
framework), the repo root holds the CLI and installers, `editors/vscode` a VS
Code entry point, and `gui/` an Electron app.

## Providers

DeepSeek is the default provider; the same provider slot can point at any
OpenAI-compatible endpoint through `DEEPSEEK_BASE_URL` (for example a MiniMax
gateway). Other providers (OpenAI, Anthropic, OpenRouter, xAI, and more) are
built in and selected with `--provider` or `DSCODE_PROVIDER`.

Transports: `responses` (default) or `chat` (OpenAI chat-completions), set with
`DSCODE_TRANSPORT`.

## Key commands

- `/status` - model, access, context budget, cache, tokens, cost, budget line
- `/doctor` - runtime diagnostics including sandbox guidance
- `/model`, `/effort` - model and thinking-effort selection
- `/permissions`, `/plan` - access modes
- `/undo`, `/checkpoints`, `/diff` - patch checkpoint management
- `/rewind` - restore a checkpoint: conversation, files, or both
- `/taste` - learned preferences (import from Claude Code / Codex / Cursor,
  learn conventions from a codebase)
- `/schedule`, `/budget`, `/fallback`, `/vault` - automation and safety tools
- `/compact`, `/export`, `/tree` - session management

## Where things live

- Sessions: `~/.dscode/sessions/YYYY/MM/DD` (JSONL, tree-shaped)
- Credentials: `~/.dscode/auth.json` plus the OS keyring
- Schedules: `<project>/.dscode/schedules.json`
- Vault: `~/.dscode/mcp-vault.json` (0600)
- Memory: `AGENTS.md` / `CLAUDE.md` layered per project, `~/.dscode/AGENTS.md`
  for personal instructions

Use the `dscode_knowledge` tool with a topic to read the matching reference in
this directory.
