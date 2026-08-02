---
description: Run a thorough, source-heavy investigation on a topic and produce a durable research brief with inline citations.
args: <topic>
section: Research Workflows
topLevelCli: true
---
## Tool Discipline (Read First)

Tool names are literal. Use only tools visible in the current tool set.

- Search with `web_search`; do not call `search_web`, `google_search`, or `WebSearch`.
- Fetch URLs by reading the snippet content returned from `web_search` (DSCode does not expose `fetch_content`).
- To ask the user a question, write plain chat text and wait for the next user message.
- Do not use `Task` as an agent dispatcher. Use only the `delegate` tool — roles: `explorer`, `reviewer`, `verifier`, `deep-research`, `code-auditor`, `paper-reviewer`, `researcher`, `writer`.
- If a tool returns `Tool not found` or `Invalid URL`, do not retry the same invalid call.

Run deep research for: $@

This is an execution request, not a request to explain or implement the workflow instructions.
Execute the workflow. Do not answer by describing the protocol, do not explain these instructions, and do not restate the protocol. Your first actions should be tool calls that create directories and write the plan artifact.

## Required Artifacts

Derive a short slug from the topic: lowercase, hyphenated, no filler words, at most 5 words.

Every run must leave these files on disk:
- `outputs/.plans/<slug>.md`
- `outputs/.drafts/<slug>-draft.md`
- `outputs/.drafts/<slug>-cited.md`
- `outputs/<slug>.md` or `papers/<slug>.md`
- `outputs/<slug>.provenance.md` or `papers/<slug>.provenance.md`

After the user approves the plan, if any capability fails, continue in degraded mode and still write a blocked or partial final output and provenance sidecar. Never end with chat-only output after plan approval.

## Step 1: Plan

Create `outputs/.plans/<slug>.md` immediately. The plan must include:
- Key questions
- Evidence needed
- Scale decision
- Task ledger
- Verification log
- Decision log

Make the scale decision before assigning owners in the plan. If the topic is a narrow "what is X" explainer, the plan must use lead-owned direct search tasks only; do not allocate researcher tasks in the task ledger.

After writing the plan, stop and ask for explicit confirmation before gathering evidence. Summarize the plan briefly and ask:

`Proceed with this deep research plan? Reply "yes" to continue, or tell me what to change.`

Do not run searches, fetch sources, delegate tasks, draft, cite, review, or deliver final artifacts until the user confirms. If the user requests changes, update `outputs/.plans/<slug>.md` first, then ask for confirmation again.

## Step 2: Scale

Use direct search for:
- Single fact or narrow question, including "what is X" explainers
- Work you can answer with 3-10 tool calls

Use `delegate` only when decomposition clearly helps:
- Direct comparison of 2-3 items: 2 `deep-research` tasks (pass concrete deliverables to each task string)
- Broad survey or multi-faceted topic: 3-4 `deep-research` tasks
- Researcher-style sweep: 3-6 `researcher` tasks for source-grounded note gathering

## Step 3: Gather Evidence

Search and fetch sources using `web_search`. Record findings and build a comprehensive research summary. Treat each `web_search` hit's snippet as the primary source material; do not fabricate full-text content beyond what the snippet actually says.
