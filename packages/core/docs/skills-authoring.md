# Skills

Skills are on-demand instruction packs the model loads by name. DSCode reads
them from the project (`.dscode/skills/` or `.agents/skills/`), the user home
(`~/.dscode/skills/`), and ships a set of its own.

## Format

A skill is a directory containing `SKILL.md`:

```markdown
---
name: my-skill
description: What it does and when to use it.
---

Step-by-step instructions for the agent, written imperatively.
Use exact commands. Include one worked example.
```

- `name`: lowercase/hyphens, 1-64 chars, must match the directory name.
- `description`: the only discovery surface - say what it does AND when to
  use it (under ~1024 chars).
- Optional: `allowed-tools`, `argument-hint`, `license`, `compatibility`.
- Supporting files live next to SKILL.md and are read on demand (progressive
  disclosure: keep the body focused, push detail into `references/`).

## Writing a good one

1. One capability per skill; trigger phrases belong in the description.
2. Write for the agent: imperative steps, exact commands, decision rules.
3. Include a verification step - how does the agent know it worked?
4. Invoke via `/name` and trim anything that turned out unnecessary.

## Managing

`/taste` is different - it holds learned preferences, not authored skills.
Installed task skills (bugfix, code-review, test-gen, and friends) live in
`~/.dscode/skills/` and can be inspected or edited directly.
