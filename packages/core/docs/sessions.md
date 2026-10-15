# Sessions, checkpoints, and rewind

## Storage

Sessions are append-only JSONL trees under
`~/.dscode/sessions/YYYY/MM/DD`. Branching never deletes history: a branch
moves a leaf pointer, so rewinding keeps the abandoned path in the file.

## Checkpoints

Every successful `apply_patch` stores a durable checkpoint (before/after
content snapshots) as a session entry. `/checkpoints` lists them, `/diff`
shows the latest patch, `/undo` restores the most recent one (conflicts
detected; `--force` overrides).

## /rewind

`/rewind` lists the last eight turn-scoped restore points and offers three
modes:

- **Conversation and code** - branch the session back and restore files
- **Conversation only** - branch back, keep current files
- **Code only** - restore files, keep the conversation

File restore replays every patch checkpoint captured after the target point,
newest first. The original prompt is put back into the input box.

## Tools

`/resume`, `/continue`, `--fork` cover session switching. `/export` writes a
transcript copy. Background compaction keeps long sessions within the
context window; `/compact` forces it.
