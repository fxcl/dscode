---
name: refactor
description: Restructure existing code to improve clarity, reduce duplication, or simplify modules while preserving observable behavior. Use when the user says "refactor this", "clean up this code", "simplify", or wants to reduce complexity without changing what the code does.
---

# Refactor

Behavior must stay identical. Tests are the contract.

## Before changing

- Identify the safety net: existing tests, a type checker, or a characterization test.
- If there is no safety net, add one before refactoring.

## Priorities (highest value first)

1. Remove duplication (extract a function or module).
2. Clarify naming and intent.
3. Simplify control flow; reduce nesting.
4. Tighten module boundaries; hide internals.

## Approach

- Take small, verifiable steps. Run the tests after each step.
- Keep diffs reviewable: one kind of change per step.
- Prefer pure functions and narrow, explicit interfaces.

## Constraints

- Do not change public behavior or API contracts during a refactor.
- If a behavior change is genuinely needed, call it out separately — do not smuggle it into the refactor.
