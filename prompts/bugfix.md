---
description: Diagnose a bug from symptoms, find the root cause, and apply a verified fix.
args: <description>
section: Coding Workflows
topLevelCli: true
---
## Bug Fix Workflow

Bug report: $@

This is an execution request. Diagnose and fix the bug now.

## Step 1: Reproduce

- Identify the failing behavior from the description.
- Find the relevant test command or write a minimal reproduction.
- Confirm the bug exists: run the reproduction and capture the failure output.

## Step 2: Isolate

- Use search tools to locate the responsible code path.
- Read the function and its callers to understand expected vs actual behavior.
- Check git log for recent changes to the suspect area: `git log --oneline -10 -- <file>`.
- Form a hypothesis about the root cause.

## Step 3: Fix

- Apply the minimal fix that addresses the root cause, not the symptom.
- Use apply_patch for the change.
- Keep the fix focused: one logical change, no drive-by refactoring.

## Step 4: Verify

- Re-run the reproduction: confirm the failure is resolved.
- Run the existing test suite for the affected module.
- If no regression test exists, add one that fails without the fix and passes with it.
- Run typecheck / lint if available.

## Constraints

- Do not guess. Reproduce first, then fix.
- If the root cause is unclear after investigation, report findings and hypotheses rather than applying a speculative fix.
- Never suppress errors (catch-and-ignore) as a "fix".
- Preserve existing behavior for unrelated code paths.
