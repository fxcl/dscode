---
description: Produce a concise, executive-level technical summary of a research paper, repository, or complex document.
args: <target>
section: Research Workflows
topLevelCli: true
---
## Technical Summarization Protocol

Tool discipline:
- Use `web_search` and `web_search` snippets as primary source material (DSCode does not expose `fetch_content`).
- For delegated analysis, use `delegate` with roles: `paper-reviewer`, `researcher`, `writer`.

Summarize: $@

Requirements:
- Extract the core problem, proposed solution, key architectural decisions, and performance claims.
- Structure output as:
  1. Executive Summary (1-2 paragraphs)
  2. Key Technical Contributions (bullet points)
  3. Architecture & Trade-offs
  4. Practical Implications for DSCode Engine / Project
- Save summary to `outputs/<slug>-summary.md`.
