---
description: Generate focused tests for a module, function, or recent change.
args: <target>
section: Coding Workflows
topLevelCli: true
---
## Test Generation Workflow

Generate tests for: $@

This is an execution request. Write and verify tests now.

## Step 1: Discover

- Read the target source to understand its contract.
- Find the existing test directory and framework (vitest, jest, node:test, pytest, etc.).
- Note existing test patterns: file naming, helpers, fixtures, mock style.

## Step 2: Identify Cases

List the test cases to cover:
- Happy path (primary use case)
- Edge cases (empty input, boundary values, null/undefined)
- Error paths (invalid input, network failure, timeout)
- Integration seams (if the target calls external services)

## Step 3: Write

- Follow the project's existing test conventions exactly.
- One describe/test block per logical case.
- Use descriptive test names that state the behavior: "returns empty array when input is null".
- Prefer real implementations over mocks unless the dependency is slow or non-deterministic.
- Keep assertions specific: assert exact values, not just truthiness.

## Step 4: Verify

- Run the new tests and confirm they pass.
- Run the full test file to check for interference.
- If a test reveals a bug in the source, report it but do not fix unless asked.

## Constraints

- Do not modify source code unless a test reveals a clear bug (report it instead).
- Match the project's assertion style (expect vs assert).
- No snapshot tests unless the project already uses them.
- Each test must be independently runnable and order-independent.
