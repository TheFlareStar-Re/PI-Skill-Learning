"use strict";

/**
 * Sidecar agent extension (spec 16). CJS so jiti does not need import.meta.
 * Tools: execute(toolCallId, params, signal, onUpdate)
 * before_agent_start may return { systemPrompt } (replaces the whole prompt).
 */

const path = require("node:path");
const fs = require("node:fs");

try {
  delete require.cache[require.resolve("./skill-store.js")];
} catch {
  /* not cached yet */
}
try {
  delete require.cache[require.resolve("./review-prompt.js")];
} catch {
  /* not cached yet */
}
try {
  delete require.cache[require.resolve("./prompt-compose.js")];
} catch {
  /* not cached yet */
}
const store = require("./skill-store.js");
const prompts = require("./review-prompt.js");
const compose = require("./prompt-compose.js");
const PLUGIN_VERSION = "0.1.8";
const PLUGIN_ID = "cn.star.skill-learning";

let Type;
try {
  ({ Type } = require("typebox"));
} catch {
  Type = null;
}

function stringParam(description, optional) {
  if (Type) {
    const t = Type.String({ description });
    return optional ? Type.Optional(t) : t;
  }
  return { type: "string", description };
}

function buildParameters() {
  if (Type) {
    return Type.Object({
      action: stringParam("create | patch | write_file | delete"),
      name: stringParam("lowercase-hyphenated skill name"),
      content: stringParam("Full SKILL.md for create, or support-file body", true),
      old_string: stringParam("Exact unique substring to replace (patch)", true),
      new_string: stringParam("Replacement (patch)", true),
      file_path: stringParam("references|templates|scripts/<file> for write_file", true),
    });
  }
  return {
    type: "object",
    properties: {
      action: { type: "string", description: "create | patch | write_file | delete" },
      name: { type: "string", description: "lowercase-hyphenated skill name" },
      content: { type: "string", description: "Full SKILL.md for create, or support-file body" },
      old_string: { type: "string", description: "Exact unique substring to replace (patch)" },
      new_string: { type: "string", description: "Replacement (patch)" },
      file_path: { type: "string", description: "references|templates|scripts/<file>" },
    },
    required: ["action", "name"],
  };
}

const turn = {
  toolCalls: 0,
  usedSkillManage: false,
  readNames: new Set(),
  seenToolIds: new Set(),
  trace: [],
  cwd: undefined,
};

let lastReviewAt = 0;

function resetTurn(ctx) {
  turn.toolCalls = 0;
  turn.usedSkillManage = false;
  turn.readNames = new Set();
  turn.seenToolIds = new Set();
  turn.trace = [];
  if (ctx && ctx.cwd) turn.cwd = ctx.cwd;
}

function noteTool(event) {
  const id = String((event && (event.toolCallId || event.id)) || "");
  const name = String((event && (event.toolName || event.name)) || "");
  const key = id || `${name}:${turn.toolCalls}`;
  if (turn.seenToolIds.has(key)) return;
  turn.seenToolIds.add(key);
  turn.toolCalls += 1;
  if (name === "skill_manage") turn.usedSkillManage = true;
  const input = event && (event.input !== undefined ? event.input : event.args || event.arguments);
  const filePath = String((input && (input.path || input.file_path || input.filePath)) || "");
  if (String(name).toLowerCase() === "read" && /SKILL\.md$/i.test(filePath)) {
    const parts = filePath.split("\\").join("/").split("/");
    const idx = parts.lastIndexOf("skills");
    if (idx >= 0 && parts[idx + 1] && parts[idx + 2] === "SKILL.md" && !parts[idx + 1].startsWith(".")) {
      turn.readNames.add(parts[idx + 1]);
    }
  }
  turn.trace.push({
    role: "tool",
    toolName: name || undefined,
    content: `${name} ${JSON.stringify(input || {}).slice(0, 800)}`.slice(0, 1500),
  });
}

function logEnqueue(root, message) {
  try {
    store.ensureDir(store.metaDir(root));
    fs.appendFileSync(path.join(store.metaDir(root), "enqueue.log"), `${new Date().toISOString()} ${message}
`, "utf8");
  } catch {
    /* ignore */
  }
}

function currentRoot(cwd) {
  const globalRoot = store.learnedRoot({ scope: "global" });
  const cfg = store.loadConfig(globalRoot);
  return store.learnedRoot(cfg, cwd || turn.cwd);
}

function textResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify({ pluginVersion: PLUGIN_VERSION, ...payload }, null, 2) }],
    details: {},
  };
}

function errorResult(message) {
  return textResult({ ok: false, error: message });
}

function skillsPathIn(text) {
  return /(?:^|[\\/])\.agents[\\/]+skills(?:[\\/]|$)/i.test(String(text || ""));
}

function isBlockedSkillsWrite(toolName, input) {
  const n = String(toolName || "").toLowerCase();
  if (n === "skill_manage" || n === "read" || n === "grep" || n === "glob") return false;
  const blob = typeof input === "string" ? input : JSON.stringify(input || {});
  if (!skillsPathIn(blob)) return false;
  if (n === "bash" || n === "shell") {
    return /(>>?|out-file|set-content|add-content|new-item|mkdir|ni\s|echo\s)/i.test(blob);
  }
  if (n === "write" || n === "edit" || n === "strreplace") return true;
  return /SKILL\.md/i.test(blob);
}

function skillLearningExtension(pi) {
  try {
    store.migrateNestedLearned(store.learnedRoot({ scope: "global" }));
  } catch {
    /* ignore */
  }
  try {
    const cfg = store.loadConfig(store.learnedRoot({ scope: "global" }));
    compose.writeFragment(PLUGIN_ID, cfg.enabled ? prompts.NUDGE : "");
  } catch (err) {
    compose.log(`init-fail ${err && err.message ? err.message : err}`);
  }

  pi.registerTool({
    name: "skill_manage",
    label: "Skill manage",
    description:
      "Create or patch a SKILL.md under ~/.agents/skills/<name>/ (visible in Settings → Skills). create MUST include When to Use, Procedure with verbatim commands, Pitfalls, and Verification — thin summaries are rejected. Prefer patch after reading the existing file.",
    parameters: buildParameters(),
    async execute(_id, params) {
      try {
        const root = currentRoot();
        store.ensureDir(root);
        const cfg = store.loadConfig(root);
        if (!cfg.enabled) return errorResult("learning loop is disabled in plugin settings");
        const action = String(params?.action || "");
        const name = String(params?.name || "");
        if (action === "patch" && !turn.readNames.has(name)) {
          return errorResult(
            `read-before-write: read the learned SKILL.md for "${name}" in this turn, then retry patch`,
          );
        }
        const createdBy = "agent";
        let result;
        if (action === "create") {
          result = store.createSkill(root, { name, content: String(params.content || ""), createdBy });
        } else if (action === "patch") {
          result = store.patchSkill(root, {
            name,
            oldString: String(params.old_string || ""),
            newString: String(params.new_string || ""),
          });
        } else if (action === "write_file") {
          result = store.writeSupportFile(root, {
            name,
            filePath: String(params.file_path || ""),
            content: String(params.content || ""),
          });
        } else if (action === "delete") {
          result = store.archiveSkill(root, name);
        } else {
          return errorResult(`unknown action "${action}"`);
        }
        turn.usedSkillManage = true;
        return textResult(result);
      } catch (err) {
        return errorResult(String(err && err.message ? err.message : err));
      }
    },
  });

  pi.on("tool_call", (event) => {
    const input = event && (event.input !== undefined ? event.input : event.args);
    if (isBlockedSkillsWrite(event && event.toolName, input)) {
      return {
        block: true,
        reason:
          "Do not Write/Edit/Bash into ~/.agents/skills. Create or patch skills only with skill_manage. Thin drafts are rejected by that tool.",
      };
    }
    return undefined;
  });

  pi.registerCommand("learn", {
    description: "Distill a reusable learned skill from a path, URL, or this conversation",
    async handler(args, ctx) {
      const prompt = prompts.buildLearnPrompt(args);
      try {
        if (typeof pi.sendUserMessage === "function") {
          await pi.sendUserMessage(prompt);
        }
        if (ctx && ctx.ui && typeof ctx.ui.notify === "function") {
          ctx.ui.notify("Queued /learn — gather sources, then call skill_manage.");
        }
      } catch (err) {
        if (ctx && ctx.ui && typeof ctx.ui.notify === "function") {
          ctx.ui.notify(`/learn failed: ${String(err && err.message ? err.message : err)}`);
        }
      }
    },
  });

  // Grok Enhance owns { systemPrompt }. Never return a replacement here.
  pi.on("before_agent_start", (_event, ctx) => {
    resetTurn(ctx);
    return undefined;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (turn.toolCalls === 0) resetTurn(ctx);
    else if (ctx && ctx.cwd) turn.cwd = ctx.cwd;
  });

  pi.on("tool_call", (event) => {
    noteTool(event);
    return undefined;
  });

  pi.on("tool_execution_end", (event) => {
    noteTool(event);
  });

  pi.on("agent_end", (event, ctx) => {
    try {
      if (ctx && ctx.cwd) turn.cwd = ctx.cwd;
      const root = currentRoot(turn.cwd);
      const cfg = store.loadConfig(root);
      if (!cfg.enabled || !cfg.reviewEnabled) {
        logEnqueue(root, `skip disabled tools=${turn.toolCalls}`);
        return;
      }
      if (turn.usedSkillManage) {
        logEnqueue(root, `skip skill_manage-already tools=${turn.toolCalls}`);
        return;
      }
      const minCalls = Number(cfg.reviewAfterToolCalls || 10);
      if (turn.toolCalls < minCalls) {
        logEnqueue(root, `skip too-few tools=${turn.toolCalls} min=${minCalls}`);
        return;
      }
      const now = Date.now();
      if (now - lastReviewAt < Number(cfg.minReviewIntervalSec || 120) * 1000) {
        logEnqueue(root, `skip cooldown tools=${turn.toolCalls}`);
        return;
      }

      const qdir = store.queueDir(root);
      store.ensureDir(qdir);
      const existing = fs
        .readdirSync(qdir)
        .filter((f) => f.endsWith(".json") && !f.includes(".done") && !f.includes(".err") && !f.includes(".lock") && !f.includes(".skip"));
      const maxQueue = Number(cfg.maxQueue || 2);
      if (existing.length >= maxQueue) {
        existing.sort();
        for (const extra of existing.slice(0, existing.length - maxQueue + 1)) {
          try {
            fs.unlinkSync(path.join(qdir, extra));
          } catch {
            /* ignore */
          }
        }
      }

      const sourceMessages =
        event && Array.isArray(event.messages) && event.messages.length ? event.messages : turn.trace;
      const packed = store.packMessages(sourceMessages);
      if ((!packed.messages || packed.messages.length < 2) && turn.trace.length) {
        const traced = store.packMessages(turn.trace);
        if (traced.messages.length > packed.messages.length) {
          packed.messages = traced.messages;
          packed.chars = traced.chars;
          packed.truncated = traced.truncated;
        }
      }
      const picked = store.selectReviewBodies(root, JSON.stringify(packed.messages));
      const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const job = {
        v: 1,
        id,
        pluginVersion: PLUGIN_VERSION,
        workspace: turn.cwd || null,
        toolCallCount: turn.toolCalls,
        createdAt: new Date().toISOString(),
        learnedCatalog: picked.catalog.map((s) => ({ name: s.name, description: s.description })),
        skillBodies: picked.skillBodies,
        ...packed,
      };
      store.atomicWrite(path.join(qdir, `${id}.json`), `${JSON.stringify(job)}\n`);
      store.atomicWrite(
        path.join(store.metaDir(root), "last-enqueue.json"),
        `${JSON.stringify({ id, pluginVersion: PLUGIN_VERSION, toolCallCount: turn.toolCalls, at: job.createdAt, bodies: picked.skillBodies.map((s) => s.name) }, null, 2)}\n`,
      );
      lastReviewAt = now;
      logEnqueue(root, `enqueued ${id} tools=${turn.toolCalls} msgs=${packed.messages.length} bodies=${picked.skillBodies.length}`);
    } catch (err) {
      try {
        const root = currentRoot(turn.cwd);
        logEnqueue(root, `enqueue-fail ${err && err.message ? err.message : err}`);
      } catch {
        /* ignore */
      }
    }
  });
}

module.exports = skillLearningExtension;
module.exports.default = skillLearningExtension;
