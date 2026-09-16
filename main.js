"use strict";

/**
 * Plugin process: settings → config file, background review via pi.agent.complete
 * (tools: []), library view. Skill writes go through src/skill-store.js (Node fs),
 * same pattern as pi.file-manager — host fs.write cannot target ~/.agents.
 */

const fs = require("node:fs");
const path = require("node:path");
const store = require("./src/skill-store.js");
const prompts = require("./src/review-prompt.js");
const apply = require("./src/review-apply.js");

const PLUGIN_VERSION = "0.1.8";

let pollTimer;
let running = false;

function globalRoot() {
  return store.learnedRoot({ scope: "global" });
}

function rootForJob(job) {
  const cfg = store.loadConfig(globalRoot());
  return store.learnedRoot(cfg, job && job.workspace);
}

async function syncConfigFromSettings() {
  const settings = await pi.plugin.getSettings();
  const root = globalRoot();
  store.ensureDir(root);
  store.saveConfig(root, {
    enabled: settings.enabled !== false,
    reviewEnabled: settings.reviewEnabled !== false,
    reviewAfterToolCalls: Number(settings.reviewAfterToolCalls || 10),
    scope: settings.scope === "project" ? "project" : "global",
    writeApproval: settings.writeApproval || "notify",
    modelKey: String(settings.modelKey || ""),
  });
}

function extractJson(text) {
  return apply.extractJson(text);
}

async function resolveModelKey(configured) {
  if (configured && String(configured).includes("/")) return String(configured);
  const models = await pi.models.list();
  if (!Array.isArray(models) || !models.length) throw new Error("no authenticated model for review");
  const grok = models.find((m) => /grok/i.test(String(m.key || m.id || m.modelId || "")));
  return (grok && grok.key) || models[0].key;
}

function writeLastReview(root, summary) {
  try {
    store.atomicWrite(path.join(store.metaDir(root), "last-review.json"), `${JSON.stringify({ pluginVersion: PLUGIN_VERSION, ...summary }, null, 2)}
`);
  } catch {
    /* ignore */
  }
}

async function completeReview(modelKey, userContent) {
  const completion = await pi.agent.complete({
    modelKey,
    system: prompts.REVIEW_SYSTEM,
    messages: [{ role: "user", content: userContent }],
  });
  return apply.completionText(completion);
}

async function processJob(file) {
  const raw = fs.readFileSync(file, "utf8");
  const job = JSON.parse(raw);
  const root = rootForJob(job);
  const cfg = store.loadConfig(root);
  if (!cfg.enabled || !cfg.reviewEnabled) {
    fs.renameSync(file, file.replace(/\.json$/, ".skip.json"));
    return;
  }
  const modelKey = await resolveModelKey(cfg.modelKey);
  let user = prompts.packReviewUser(job);
  let text;
  try {
    text = await completeReview(modelKey, user);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (!/timed out|timeout/i.test(msg)) throw err;
    text = await completeReview(modelKey, apply.shrinkReviewUser(user, 40000));
  }
  let parsed;
  try {
    parsed = apply.extractJson(text);
  } catch (err) {
    text = await completeReview(
      modelKey,
      apply.shrinkReviewUser(`${user}

Previous output was not JSON. Return ONLY the JSON object.`, 40000),
    );
    parsed = apply.extractJson(text);
  }
  const normalized = apply.normalizeReview(parsed);
  const applied = normalized.ops.length ? store.applyOps(root, normalized.ops, "agent") : [];
  const summary = {
    id: job.id,
    decision: normalized.decision,
    reason: normalized.reason,
    applied,
    modelKey,
    pluginVersion: PLUGIN_VERSION,
    at: new Date().toISOString(),
  };
  store.atomicWrite(file.replace(/\.json$/, ".done.json"), `${JSON.stringify(summary, null, 2)}
`);
  writeLastReview(root, summary);
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }

  const wrote = applied.filter((r) => r.result && r.result.ok);
  const failed = applied.filter((r) => r.error);
  if (cfg.writeApproval !== "off") {
    if (wrote.length) {
      const names = wrote.map((r) => r.result.name).join(", ");
      await pi.ui.showToast(`Learned skill: ${names}`);
    } else if (normalized.decision === "skip") {
      // stay quiet on skip
    } else if (failed.length) {
      await pi.ui.showToast(`Skill review failed: ${failed[0].error}`);
    }
  }
}

async function pollQueue() {
  if (running) return;
  running = true;
  try {
    const cfg = store.loadConfig(globalRoot());
    const roots = new Set([globalRoot()]);
    if (cfg.scope === "project") {
      try {
        const ws = await pi.workspace.get();
        if (ws && ws.path) roots.add(store.learnedRoot(cfg, ws.path));
      } catch {
        /* no workspace */
      }
    }
    for (const root of roots) {
      const qdir = store.queueDir(root);
      if (!fs.existsSync(qdir)) continue;
      const jobs = fs
        .readdirSync(qdir)
        .filter((f) => f.endsWith(".json") && !f.includes(".done") && !f.includes(".err") && !f.includes(".skip"))
        .sort();
      for (const name of jobs) {
        const file = path.join(qdir, name);
        try {
          await processJob(file);
        } catch (err) {
          const msg = String(err && err.message ? err.message : err);
          try {
            store.atomicWrite(
              file.replace(/\.json$/, ".err.json"),
              `${JSON.stringify({ error: msg, at: new Date().toISOString() }, null, 2)}\n`,
            );
            fs.unlinkSync(file);
          } catch {
            /* ignore */
          }
        }
      }
    }
  } finally {
    running = false;
  }
}

async function onLoad() {
  await syncConfigFromSettings();
  try {
    const moved = store.migrateNestedLearned(globalRoot());
    if (moved.moved && moved.moved.length) {
      await pi.ui.showToast(`Moved ${moved.moved.length} skill(s) into Skills UI`);
    }
  } catch {
    /* ignore */
  }

  await pi.commands.register({
    id: "skill-learning.open",
    title: "Skill Learning: Library",
    keywords: ["skill", "learn", "library"],
    run: async () => {
      await pi.ui.showToast(`${store.listSkills(globalRoot()).length} learned skill(s)`);
    },
  });

  await pi.commands.register({
    id: "skill-learning.review-now",
    title: "Skill Learning: Drain review queue",
    keywords: ["skill", "review"],
    run: async () => {
      await pollQueue();
      await pi.ui.showToast("Review queue drained");
    },
  });

  if (pi.events && typeof pi.events.on === "function") {
    pi.events.on("plugin:settingsChanged", () => {
      void syncConfigFromSettings();
    });
  }

  pi.services.register({
    id: "reviewer",
    start: ({ log }) => {
      log("skill-learning reviewer started");
      void pollQueue();
      pollTimer = setInterval(() => {
        void pollQueue();
      }, 3000);
    },
    stop: () => {
      clearInterval(pollTimer);
      pollTimer = undefined;
    },
  });
}

async function onUnload() {
  clearInterval(pollTimer);
  pollTimer = undefined;
  try {
    await pi.commands.unregister("skill-learning.open");
    await pi.commands.unregister("skill-learning.review-now");
  } catch {
    /* ignore */
  }
}

async function onPanelInvoke(channel) {
  if (channel === "library.list") {
    const root = globalRoot();
    const cfg = store.loadConfig(root);
    return { skills: store.listSkills(root), config: cfg, root };
  }
  if (channel === "library.archive") {
    return { error: "use the agent skill_manage delete action, or restore from .archive/" };
  }
  return { error: `unknown channel ${channel}` };
}

module.exports = { onLoad, onUnload, onPanelInvoke };
