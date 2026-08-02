---
description: Plan and execute a focused refactoring with verification at each step.
args: <target>
section: Coding Workflows
topLevelCli: true
---
## Refactoring Workflow

Refactor target: $@

This is an execution request. Perform the refactoring now.

## Step 1: Understand

- Read the target code and its callers/callees.
- Identify the refactoring goal (extract, inline, rename, restructure, decouple).
- Run existing tests to establish a green baseline: identify the test command first.

## Step 2: Plan

Publish a plan using update_plan:
- List each atomic refactoring step.
- Note which files are affected.
- Identify risk points (public API changes, cross-module coupling).

## Step 3: Execute

For each step:
1. Make the focused change using apply_patch.
2. Run the narrowest relevant check (typecheck, lint, unit test).
3. If the check fails, fix before proceeding.
4. Update plan status.

## Step 4: Verify

- Run the full test suite.
- Run typecheck / lint if available.
- Confirm no unrelated changes leaked in (`git diff --stat`).

## Constraints

- One logical change per patch. Keep patches reviewable.
- Never break the build between steps.
- Preserve public API unless the goal explicitly includes changing it.
- If tests are missing for the refactored path, add a minimal regression test.
