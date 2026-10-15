# Memory files

DSCode layers instruction files into the system prompt on every turn:

1. **User**: `~/.dscode/AGENTS.md` - personal preferences across projects.
2. **Project**: first existing of `AGENTS.md`, `CLAUDE.md`,
   `.dscode/AGENTS.md` at the workspace root.
3. **Nested** (activated by mentions): when a user message references a file
   under the workspace, the first existing memory file at each ancestor
   directory between the workspace root and that file is loaded too - so a
   monorepo package can carry its own `AGENTS.md` that activates only when
   you mention its files.

Each block is rendered as `# Memory from: <path>` and blocks are separated by
`---`. Files are capped per file and deduplicated.

## @imports

Inside any memory file, a whitespace-anchored `@path` mention inlines the
referenced file:

- `~/x.md` resolves to your home directory; bare paths resolve relative to
  the file containing the mention.
- Fenced code blocks and inline code are exempt - `@x` inside backticks does
  not import.
- Imports nest up to depth 5; unresolvable mentions stay as written.

## Tips

- Keep project memory about conventions and commands, not task state.
- The `/init` flow and `session-log` skill complement memory: memory is
  always-on context, session logs are on-demand history.
- `/taste` is separate: it stores learned preferences from conversations
  under `.dscode/taste/` with confidence scores.
