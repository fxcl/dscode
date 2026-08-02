---
name: commit
description: Craft a clear commit message following Conventional Commits and stage a focused changeset. Use when the user says "commit this", "write a commit message", or wants to create a commit from staged or unstaged changes.
---

# Commit

One logical change per commit. Conventional Commits format.

## Before committing

- Review `git status` and `git diff` (staged and unstaged).
- Ensure the changeset is focused; split if it mixes unrelated concerns.
- Do not commit secrets, keys, or large generated files.

## Message format

```
<type>(<scope>): <subject>

<body: what and why>
```

- **type**: `feat` | `fix` | `refactor` | `test` | `docs` | `chore` | `perf` | `build` | `ci`
- **subject**: imperative mood, lowercase, no trailing period, ≤72 characters.
- **body**: explain the motivation, not just the diff. Wrap near 72 characters.

## Constraints

- Never amend, force-push, or rewrite shared history without explicit user approval.
- Do not add `Co-Authored-By` or other attribution lines unless asked.
- If tests or lint are expected to pass, confirm they do before committing.
