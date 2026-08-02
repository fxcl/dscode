---
description: Compare multiple sources, technologies, or papers on a topic and produce a source-grounded matrix.
args: <topic>
section: Research Workflows
topLevelCli: true
---
## Tool Discipline (Read First)

Tool names are literal. Use only tools visible in the current tool set.
- Search with `web_search`; do not call `search_web` or `google_search`.
- Fetch URLs with `fetch_content` or `read_url_content`.
- To ask the user a question, write plain chat text and wait for the next user message.

Compare sources for: $@

Derive a short slug from the comparison topic (lowercase, hyphens, no filler words, ≤5 words). Use this slug for all files in this run.

Requirements:
- Before starting, outline the comparison plan: which sources to compare, which dimensions to evaluate, expected output structure. Write the plan to `outputs/.plans/<slug>.md`.
- Use the `deep-research` or `paper-reviewer` subagent to gather source material when the comparison set is broad.
- Build a comparison matrix covering: source/tech, key claim/feature, evidence type, trade-offs, confidence.
- Use Mermaid for method or architecture comparisons when the structure is source-supported.
- Distinguish agreement, disagreement, and uncertainty clearly.
- Save exactly one comparison to `outputs/<slug>-comparison.md`.
- End with a `Sources` section containing direct URLs for every source used.
