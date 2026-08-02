---
description: Run an adversarial audit and evidence verification pipeline on a feature or code path.
args: <target-or-feature>
section: Verification Workflows
topLevelCli: true
---
## Adversarial Audit & Verification Workflow

Target to audit: $@

This is an execution request. Perform a thorough audit and verification now.

## Step 1: Investigation & Evidence Gathering

- Use `explorer` or search tools to read the target implementation and all caller sites.
- Verify exact API signatures, error handling, edge cases, and test coverage.
- Execute `delegate` with `explorer` and `verifier` subagents for parallel evidence collection.

## Step 2: Adversarial Review (Reviewer & Verifier Subagent Loop)

- Dispatch a `reviewer` subagent to audit code for:
  - **[FATAL]**: Critical bugs, regressions, security flaws, memory leaks, or uncaught exceptions.
  - **[MAJOR]**: Unverified assumptions, missing test cases, logic flaws under boundary conditions.
  - **[MINOR]**: Style inconsistencies, dead code, or clarity improvements.
- Dispatch a `verifier` subagent to physically run tests/diagnostics and verify that all claimed behaviors are backed by disk evidence.

## Step 3: Provenance & Audit Artifact Generation

- Synthesize findings into `outputs/.plans/<slug>-audit.md`.
- Generate a `.provenance.md` sidecar summarizing:
  - Audit Date & Model
  - Code files inspected & test commands executed
  - Categorized findings ([FATAL], [MAJOR], [MINOR])
  - Final Audit Status (`PASS`, `PASS WITH NOTES`, `BLOCKED`)

## Step 4: Verification & Resolution

- Fix any [FATAL] or [MAJOR] issues using `apply_patch`.
- Verify on disk with `exec_command` (lint/test/typecheck) and verify output before declaring complete.
