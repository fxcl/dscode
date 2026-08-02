---
description: Perform a structured code review on a file, directory, or diff with actionable findings.
args: <target>
section: Coding Workflows
topLevelCli: true
---
## Code Review Workflow

Review target: $@

This is an execution request. Perform the review now using available tools.

## Step 1: Scope

Identify the review target:
- If a file or directory path is given, read it.
- If a git ref or diff range is given, run `git diff` to obtain the changes.
- If unclear, list recent changes with `git log --oneline -5` and ask.

## Step 2: Analyze

For each file in scope, evaluate:

1. **Correctness** — logic errors, off-by-one, null/undefined risks, race conditions
2. **Security** — injection, path traversal, secret exposure, unsafe deserialization
3. **Performance** — unnecessary allocations, O(n^2) where O(n) is possible, missing indexes
4. **Maintainability** — naming, duplication, coupling, missing error handling
5. **Tests** — coverage gaps, untested edge cases, brittle assertions

## Step 3: Report

Produce a structured report:

```
## Summary
<1-2 sentence overview>

## Findings

### [severity] file:line — title
<description and suggested fix>

## Verdict
<approve | request-changes | needs-discussion>
```

Severity levels: critical, warning, suggestion, nit.

## Constraints

- Do not modify any files. This is read-only analysis.
- Cite exact line numbers.
- Prefer concrete fix suggestions over vague advice.
- If the target is too large (>2000 lines), review the most critical files first and note what was skipped.
