---
name: test-gen
description: Write tests that lock in observable behavior rather than implementation details. Use when the user says "write tests", "add coverage", "test this function", or wants a failing test for a reported bug.
---

# Test Generation

Test behavior, not implementation.

## Before writing

- Identify the smallest trustworthy proof for the behavior.
- Decide the level: unit, integration, or property test.
- Match existing test conventions in the repo (runner, style, fixtures).

## For a known bug

Write one failing test that reproduces it first, then fix.

## What makes a good test

- One behavior per test; clear arrange / act / assert.
- The name describes the scenario and the expected outcome.
- Prefer fakes and stubs over heavy mocks; avoid coupling to internals.
- Cover the edges: empty input, boundaries, errors, concurrency where relevant.

## Constraints

- Do not test private internals that will churn.
- Avoid brittle assertions tied to exact strings or ordering unless that ordering is meaningful.
- Keep tests fast and deterministic.
