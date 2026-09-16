"use strict";

const AUTHORING = `
SKILL.md quality bar (same job as Hermes native learning — not a 10-line summary):

Frontmatter:
- name: lowercase-hyphenated, matches the directory.
- description: ONE sentence, <=120 characters, ends with a period. State when to use it, not the implementation.

Required body sections (Chinese headings OK: 何时使用 / 工作流程 / 陷阱 / 验证):
1. Title + 2-3 sentence intro: what it does, what it does NOT do.
2. ## When to Use — concrete trigger phrases AND a Don't-use list.
3. ## Procedure — numbered steps. Commands, URLs, flags, error strings MUST be copied verbatim from the session. Never invent flags.
4. ## Pitfalls — things that look like success but aren't (e.g. HTTP 200 HTML), plus the correction.
5. ## Verification — one checkable criterion (file exists, UI shows X, command output contains Y).

Depth:
- Capture decision rules, not a recap of this afternoon. Class-level names (openai-compatible-base-url), never fix-issue-12.
- If the procedure is long, put tables / recipes in references/<topic>.md via write_file and link them from SKILL.md.
- Frame tools as PI: read, write, edit, bash, grep, glob. Do not mention Hermes tools.
- Prefer patching an existing managed skill over creating a near-duplicate.
`.trim();

const NUDGE = `
## Skill learning
You have a \`skill_manage\` tool that writes SKILL.md as a direct child of ~/.agents/skills/<name>/ so Settings → Skills can list it.

When to save: a non-trivial reusable workflow, a user correction, or a missing step in a skill you used.
When not to: one-off Q&A, unresolved failures, "tool X is broken", or content that already lives in a user-authored skill.

How:
- If skill_manage is missing from the tool list, activate it via ToolSearch.
- Never Write/Edit/Bash a SKILL.md under ~/.agents/skills. That path is blocked; only skill_manage may write there.
- Prefer patch. Read the existing SKILL.md first (read-before-write is enforced).
- create is REJECTED if the body is a thin summary. You must include When to Use, Procedure (verbatim commands), Pitfalls, and Verification.
- Names: class-level lowercase-hyphenated. Agent mode only.

${AUTHORING}
`.trim();

const LEARN_PREFIX = `[skill-learning /learn]
The user wants you to distill a reusable skill from what they described below.

The request may mix SOURCES (dirs, URLs, "what we just did") and REQUIREMENTS (focus/skip). Honor both.

Do this:
1. Gather sources with read / grep / glob / bash. Do not invent flags or APIs you did not see.
2. If a managed skill already covers this class, PATCH it (read SKILL.md first).
3. Otherwise create a class-level skill with skill_manage action=create.
4. Author to the quality bar below. Thin summaries will be rejected — retry with full sections.
5. Large prose sources: lean SKILL.md index + per-topic references/ files via write_file. Distill structure (rules, tables, anti-patterns), not a lossy recap.

${AUTHORING}

User request:
`;

const REVIEW_SYSTEM = `You review one finished PI-Desktop agent turn and decide whether to update the learned skill library.

Return ONLY JSON, no markdown fences:
{
  "decision": "skip" | "update",
  "reason": "short reason",
  "ops": []
}

ops items:
- {"action":"create","name":"class-level-name","content":"<full SKILL.md>"}
- {"action":"patch","name":"...","old_string":"exact unique substring from the existing skill body below","new_string":"..."}
- {"action":"write_file","name":"...","file_path":"references/topic.md","content":"..."}

${AUTHORING}

Review rules:
- skip is first-class. One-off tasks, unresolved failures, nothing reusable → skip.
- Do not write "tool X is broken". Do not save failed attempt sequences as best practice.
- Prefer patch. Existing skill bodies are included below — old_string MUST be copied from them.
- create content MUST be a complete SKILL.md (frontmatter + required sections). A 10-line recap will be rejected.
- Distill exact commands, status codes, paths, and decision rules from the transcript. Do not generalize away the numbers.
- At most 8 ops. Empty ops with decision=update is invalid — use skip.
- Do not modify skills that are not in the managed catalog below.
`;

function buildLearnPrompt(userRequest) {
  const text = String(userRequest || "").trim() || "the workflow from this conversation";
  return `${LEARN_PREFIX}${text}\n`;
}

function packReviewUser(snapshot) {
  const skills = Array.isArray(snapshot.learnedCatalog) ? snapshot.learnedCatalog : [];
  const catalog = skills.length
    ? skills.map((s) => `- ${s.name}: ${s.description || ""}`).join("\n")
    : "(none yet)";
  let bodies = "";
  let bodyBudget = 60000;
  for (const s of snapshot.skillBodies || []) {
    const chunk = String(s.content || "").slice(0, 12000);
    if (!chunk) continue;
    if (bodyBudget - chunk.length < 0) break;
    bodies += `\n\n----- existing skill ${s.name} -----\n${chunk}`;
    bodyBudget -= chunk.length;
  }
  const msgs = (snapshot.messages || [])
    .map((m) => `## ${m.role}${m.toolName ? ` (${m.toolName})` : ""}\n${m.content}`)
    .join("\n\n");
  return `Workspace: ${snapshot.workspace || "?"}\nTool calls this turn: ${snapshot.toolCallCount || "?"}\n\nManaged skills:\n${catalog}${bodies}\n\nTranscript (truncated):\n${msgs}`;
}

module.exports = {
  AUTHORING,
  NUDGE,
  LEARN_PREFIX,
  REVIEW_SYSTEM,
  buildLearnPrompt,
  packReviewUser,
};
