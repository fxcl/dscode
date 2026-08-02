---
description: Plan and execute a dependency or framework migration with incremental verification.
args: <migration>
section: Coding Workflows
topLevelCli: true
---
## Migration Workflow

Migration: $@

This is an execution request. Plan and execute the migration now.

## Step 1: Assess

- Identify what is being migrated (dependency version, framework, API, package manager).
- Read the changelog or migration guide for breaking changes.
- Inventory affected files: search for imports, config references, deprecated API usage.
- Run the test suite to establish a green baseline.

## Step 2: Plan

Publish a plan using update_plan:
- List breaking changes that affect this codebase.
- Order steps from least to most risky.
- Identify files that need changes and the nature of each change.
- Note any manual steps (config file edits, env var changes).

## Step 3: Execute

For each step:
1. Update the dependency or configuration.
2. Apply code changes using apply_patch.
3. Run typecheck after each logical group of changes.
4. Run tests after each step.
5. If tests fail, diagnose and fix before proceeding.

## Step 4: Verify

- Run the full test suite.
- Run typecheck / lint / build.
- Check for leftover deprecated imports: search for old package names.
- Verify runtime behavior if integration tests exist.
- Summarize: what changed, what was removed, any remaining TODOs.

## Constraints

- One dependency or framework per migration run.
- Do not combine the migration with feature work or refactoring.
- Pin exact versions in lockfile changes.
- If the migration is too large for one session, deliver a working subset and document the remainder.
