---
name: bugfix
description: Find the root cause of a bug before changing code, then fix with the smallest change verified by a regression test. Use when the user reports a bug, a test fails unexpectedly, behavior is wrong, or something is broken.
---

# Bugfix

Root cause first. Never guess-then-patch.

## Process

1. **Reproduce** — find the minimal steps that trigger the bug.
2. **Localize** — narrow down to the file/function using logs, tests, or a debugger.
3. **Diagnose** — explain *why* it happens, not just *where*. State the root cause explicitly.
4. **Fix** — make the smallest change that addresses the root cause.
5. **Verify** — add a regression test that fails before the fix and passes after.

## When to stop investigating

- You can state the root cause as a single precise sentence.
- A failing test reproduces it.

## Constraints

- Do not add a fix that masks the symptom without addressing the cause.
- If the bug is environment-sensitive or intermittent, say so and capture the conditions.
- Keep the fix minimal; refactor separately.
