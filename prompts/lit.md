---
description: Perform a literature and document review on a topic, mapping state-of-the-art developments and paper implementations.
args: <topic>
section: Research Workflows
topLevelCli: true
---
## Literature Review Protocol

Tool discipline:
- Search with `web_search` (DSCode does not expose `fetch_content`); rely on hit snippets as source material.
- For delegated work, use `delegate` with roles: `deep-research`, `researcher`, `paper-reviewer`.

Review literature and technical documentation for: $@

Derive a short slug from the topic (lowercase, hyphens, ≤5 words).

Requirements:
- Search recent literature, technical reports, and official documentation using `web_search`.
- Categorize findings into: Core Methodology, Key Innovations, Benchmarks/Results, Limitations & Open Questions.
- Save the detailed review to `outputs/<slug>-lit-review.md`.
- Include full citation URLs and paper titles.
