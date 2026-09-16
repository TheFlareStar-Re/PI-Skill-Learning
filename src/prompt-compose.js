"use strict";

/**
 * PI host does not chain before_agent_start: the last extension's
 * { systemPrompt } replaces everyone else's. Each plugin writes a fragment
 * under ~/.pi/agent/prompt.d/ at load AND on each turn; the last hook
 * concatenates every *.md after a short settle so parallel hooks see peers.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function promptDir(home) {
  return path.join(home || os.homedir(), ".pi", "agent", "prompt.d");
}

function fragmentPath(id, home) {
  return path.join(promptDir(home), `${id}.md`);
}

function log(message, home) {
  try {
    const dir = promptDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "_debug.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

function writeFragment(id, text, home) {
  try {
    const dir = promptDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const file = fragmentPath(id, home);
    const body = String(text || "").replace(/^\s+|\s+$/g, "");
    if (!body) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* missing */
      }
      log(`clear ${id}`, home);
      return;
    }
    fs.writeFileSync(file, `${body}\n`, "utf8");
    log(`write ${id} chars=${body.length} path=${file}`, home);
  } catch (err) {
    log(`write-fail ${id} ${err && err.message ? err.message : err}`, home);
  }
}

function listIds(home) {
  const dir = promptDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".md") && !n.startsWith("."));
}

function compose(basePrompt, home) {
  const base = String(basePrompt || "").replace(/\s+$/, "");
  const dir = promptDir(home);
  if (!fs.existsSync(dir)) return base;
  const names = listIds(home).sort();
  const parts = [];
  for (const name of names) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8").replace(/^\s+|\s+$/g, "");
    } catch {
      continue;
    }
    if (!text) continue;
    const sig = text.slice(0, Math.min(48, text.length));
    if (base.includes(sig)) continue;
    if (parts.some((p) => p.includes(sig))) continue;
    parts.push(text);
  }
  if (!parts.length) return base;
  return `${base}\n\n${parts.join("\n\n")}\n`;
}

function applyFragment(basePrompt, id, text, home) {
  writeFragment(id, text, home);
  return compose(basePrompt, home);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyFragmentAsync(basePrompt, id, text, home, settleMs) {
  writeFragment(id, text, home);
  const budget = Number.isFinite(settleMs) ? settleMs : 250;
  const start = Date.now();
  let next = compose(basePrompt, home);
  while (Date.now() - start < budget) {
    await sleep(40);
    next = compose(basePrompt, home);
  }
  log(`compose ${id} files=${listIds(home).join(",")} out=${next.length}`, home);
  return next;
}

module.exports = {
  promptDir,
  fragmentPath,
  writeFragment,
  compose,
  applyFragment,
  applyFragmentAsync,
  listIds,
  log,
};
