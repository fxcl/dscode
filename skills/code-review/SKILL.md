---
name: code-review
description: Perform a structured, read-only code review on files, directories, or diffs with actionable findings. Use when the user asks to "review this code", "look over my changes", wants a PR/diff review, or asks "is this ready to merge".
---

# Code Review

Read-only analysis. Do not modify files.

## When to use

- A file, directory, git ref, or diff range is the review target.
- The user wants a merge / PR readiness check.

## How to review

For each file in scope, evaluate:

1. **Correctness** — logic errors, null/undefined risks, off-by-one, race conditions.
2. **Security** — injection, path traversal, secret exposure, unsafe deserialization.
3. **Performance** — unnecessary allocations, accidental quadratic behavior, missing indexes.
4. **Maintainability** — naming, duplication, coupling, missing error handling.
5. **Tests** — coverage gaps, untested edge cases, brittle assertions.

## Output

Produce a structured report:

- **Summary** — 1-2 sentence overview.
- **Findings** — `[severity] file:line — title`, each with a concrete fix.
- **Verdict** — `approve` | `request-changes` | `needs-discussion`.

Severities: `critical`, `warning`, `suggestion`, `nit`.

## Constraints

- Cite exact line numbers.
- Prefer concrete fixes over vague advice.
- For targets over ~2000 lines, review the most critical files first and note what was skipped.
