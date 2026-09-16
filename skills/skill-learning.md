---
name: skill-learning
description: After a non-trivial workflow, user correction, or /learn, save a detailed skill with skill_manage.
---

# Skill learning

Save reusable procedures into `~/.agents/skills/<name>/SKILL.md` so Settings → Skills and later sessions can load them.

Thin 10-line recaps are rejected. Match Hermes-quality authoring.

## When to Use

- You just solved something that took several tool calls, a workaround, or a user correction.
- The user ran `/learn`.
- A learned skill you used is missing a step.

Do not use for one-off Q&A, unresolved failures, or "this tool is broken" notes.

## How

1. If `skill_manage` is not in the current tool list, activate it with ToolSearch.
2. Prefer **patch** on an existing managed skill. Read its `SKILL.md` first (read-before-write is enforced).
3. Otherwise **create** a class-level name (`deploy-staging`, not `fix-issue-12`).
4. Author the full SKILL.md:

```markdown
---
name: example-name
description: One sentence of when to use it.
---

# Title

What it does / does not do.

## When to Use
- triggers
Don't use for: …

## Procedure
1. Exact command copied from the session (`bash` / `read` / …)
2. …

## Pitfalls
- The thing that looked like success but wasn't.

## Verification
One checkable test.
```

5. Long recipes go in `references/<topic>.md` via `write_file`.
6. Frame tools as PI: `read`, `write`, `edit`, `bash`, `grep`, `glob`.

`skill_manage` arguments: `action` (create|patch|write_file|delete), `name`, plus `content` / `old_string` / `new_string` / `file_path`.
