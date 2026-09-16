"use strict";

/**
 * Learned-skill store. Used by both the sidecar extension and the plugin
 * process. Writes SKILL.md as a direct child of ~/.agents/skills/<name>/ so
 * PI-Desktop's Skills UI can see it. Bookkeeping lives in .skill-learning/.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESC = 240;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_ACTIVE = 80;
const SUPPORT_DIRS = new Set(["references", "templates", "scripts"]);
const INCIDENT_NAME_RE = /^(fix|debug|audit|hotfix)-|-\d{3,}$|pr-\d+/i;

const DEFAULT_CONFIG = {
  enabled: true,
  reviewEnabled: true,
  reviewAfterToolCalls: 10,
  minReviewIntervalSec: 120,
  scope: "global",
  writeApproval: "notify",
  modelKey: "",
  maxQueue: 2,
};

function homedir() {
  return os.homedir();
}

function learnedRoot(config, workspace) {
  const scope = config?.scope === "project" ? "project" : "global";
  let root;
  if (scope === "project" && workspace) {
    root = path.join(workspace, ".agents", "skills");
  } else {
    root = path.join(homedir(), ".agents", "skills");
  }
  if (path.basename(root) === "learned") root = path.dirname(root);
  return root;
}

function metaDir(root) {
  return path.join(root, ".skill-learning");
}

function queueDir(root) {
  return path.join(metaDir(root), "queue");
}

function archiveDir(root) {
  return path.join(metaDir(root), "archive");
}

function usagePath(root) {
  return path.join(metaDir(root), "usage.json");
}

function configPath(root) {
  return path.join(metaDir(root), "config.json");
}

function isManagedName(root, name) {
  const entry = loadUsage(root)[name];
  return Boolean(entry && (entry.created_by === "agent" || entry.created_by === "user") && !entry.archived_at);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  try {
    fs.unlinkSync(file);
  } catch {
    // first write
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.copyFileSync(tmp, file);
      fs.unlinkSync(tmp);
    } catch (err2) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err2 || err;
    }
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadConfig(root) {
  const raw = readJson(configPath(root), {});
  return { ...DEFAULT_CONFIG, ...(raw && typeof raw === "object" ? raw : {}) };
}

function saveConfig(root, config) {
  const next = { ...DEFAULT_CONFIG, ...config };
  atomicWrite(configPath(root), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function loadUsage(root) {
  const raw = readJson(usagePath(root), {});
  return raw && typeof raw === "object" ? raw : {};
}

function saveUsage(root, usage) {
  atomicWrite(usagePath(root), `${JSON.stringify(usage, null, 2)}\n`);
}

function stampUsage(root, name, extra) {
  const usage = loadUsage(root);
  const prev = usage[name] && typeof usage[name] === "object" ? usage[name] : {};
  usage[name] = {
    created_by: prev.created_by || extra.created_by || "agent",
    created_at: prev.created_at || new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    use_count: Number(prev.use_count || 0),
    patch_count: Number(prev.patch_count || 0) + (extra.patch ? 1 : 0),
    pinned: Boolean(prev.pinned),
    ...("created_by" in extra ? { created_by: extra.created_by } : {}),
  };
  saveUsage(root, usage);
  return usage[name];
}

function parseFrontmatter(content) {
  if (typeof content !== "string" || !content.startsWith("---")) {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }
  const close = content.indexOf("\n---", 3);
  if (close < 0) throw new Error("frontmatter is not closed");
  const fmText = content.slice(4, close).trim();
  const body = content.slice(close + 4).replace(/^\s*\n/, "");
  const fm = {};
  for (const line of fmText.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[m[1]] = v;
  }
  return { fm, body, rawFm: fmText };
}

function validateName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.length > MAX_NAME) {
    throw new Error(`invalid skill name "${name}" (lowercase hyphenated, <=${MAX_NAME})`);
  }
}

function lintsFor(name, content) {
  const lints = [];
  try {
    const { fm, body } = parseFrontmatter(content);
    const desc = String(fm.description || "");
    if (desc.length > MAX_DESC) lints.push(`description is ${desc.length} chars (cap ${MAX_DESC})`);
    if (desc.length > 120) lints.push("description is long; keep it under 120 chars so the catalog stays small");
    if (!fm.description) lints.push("missing description");
    if (fm.name && fm.name !== name) lints.push(`frontmatter name "${fm.name}" differs from directory name "${name}"`);
    if (!/(^|\n)##\s*(Pitfalls|陷阱|禁止|注意)/i.test(body)) lints.push("missing Pitfalls / 陷阱 section");
    if (!/(^|\n)##\s*(Verification|验证|验收)/i.test(body)) lints.push("missing Verification / 验证 section");
  } catch (err) {
    lints.push(String(err.message || err));
  }
  if (INCIDENT_NAME_RE.test(name)) lints.push("name looks like a one-off incident; prefer a class-level name");
  if (Buffer.byteLength(content, "utf8") > 80 * 1024) lints.push("SKILL.md is large; move depth into references/");
  return lints;
}

function structureErrors(content) {
  const errors = [];
  let body = "";
  try {
    ({ body } = parseFrontmatter(content));
  } catch (err) {
    return [String(err.message || err)];
  }
  if (body.trim().length < 800) {
    errors.push(
      "body too thin (<800 chars). Write When to Use, numbered Procedure with verbatim commands, Pitfalls, and Verification — not a session recap.",
    );
  }
  if (!/(^|\n)##\s*(When to Use|何时)/i.test(body)) {
    errors.push('missing "## When to Use" or "## 何时…"');
  }
  if (!/(^|\n)##\s*(Procedure|How to Run|工作流程|步骤)/i.test(body)) {
    errors.push('missing "## Procedure" or "## 工作流程"');
  }
  return errors;
}

function skillDir(root, name) {
  validateName(name);
  return path.join(root, name);
}

function skillFile(root, name) {
  return path.join(skillDir(root, name), "SKILL.md");
}

function assertInsideLearned(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escapes the skills directory");
  }
  if (rel.split(path.sep).includes(".skill-learning")) {
    throw new Error("refuse to write into .skill-learning/");
  }
}

function listActive(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && NAME_RE.test(d.name))
    .map((d) => d.name)
    .filter((name) => fs.existsSync(skillFile(root, name)));
}

function readSkill(root, name) {
  const file = skillFile(root, name);
  if (!fs.existsSync(file)) throw new Error(`skill "${name}" not found`);
  return fs.readFileSync(file, "utf8");
}

function listManaged(root) {
  return listActive(root).filter((name) => isManagedName(root, name));
}

function assertManaged(root, name) {
  if (!isManagedName(root, name)) {
    throw new Error(
      `skill "${name}" is not managed by skill-learning; will not modify a Skills-UI skill we did not create`,
    );
  }
}

function ensureZixiTag(content) {
  const close = content.indexOf("\n---", 3);
  if (close < 0) return content;
  const head = content.slice(0, close);
  const tail = content.slice(close);
  if (/自习/.test(head) && /^tags:/m.test(head)) return content;
  if (/^tags:/m.test(head)) {
    return (
      head.replace(/^tags:\s*\[([^\]]*)\]/m, (full, inner) => {
        const items = inner
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (items.some((x) => x.includes("自习"))) return full;
        items.push('"自习"');
        return `tags: [${items.join(", ")}]`;
      }) + tail
    );
  }
  return `${head}\ntags: ["自习"]${tail}`;
}

function createSkill(root, { name, content, createdBy }) {
  validateName(name);
  if (path.basename(root) === "learned") root = path.dirname(root);
  if (typeof content !== "string" || !content.trim()) throw new Error("content is required");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("SKILL.md exceeds 128 KiB");
  parseFrontmatter(content);
  const thin = structureErrors(content);
  if (thin.length) {
    throw new Error(`skill too thin (create rejected):\n- ${thin.join("\n- ")}\nRewrite with full sections and retry.`);
  }
  if (fs.existsSync(skillFile(root, name))) {
    if (isManagedName(root, name)) throw new Error(`skill "${name}" already exists; patch it`);
    throw new Error(`name "${name}" is taken by an existing skill in the Skills UI`);
  }
  if (listManaged(root).length >= MAX_ACTIVE) {
    throw new Error(`already have ${MAX_ACTIVE} learned skills; patch one instead`);
  }
  ensureDir(skillDir(root, name));
  content = ensureZixiTag(content);
  atomicWrite(skillFile(root, name), content.endsWith("\n") ? content : `${content}\n`);
  stampUsage(root, name, { created_by: createdBy || "agent" });
  return { ok: true, name, path: skillFile(root, name), lints: lintsFor(name, content) };
}

function patchSkill(root, { name, oldString, newString }) {
  validateName(name);
  assertManaged(root, name);
  if (typeof oldString !== "string" || !oldString) throw new Error("old_string is required");
  if (typeof newString !== "string") throw new Error("new_string is required");
  if (oldString === newString) throw new Error("old_string and new_string are identical");
  const current = readSkill(root, name);
  const count = current.split(oldString).length - 1;
  if (count === 0) throw new Error("old_string not found in SKILL.md");
  if (count > 1) throw new Error(`old_string matches ${count} times; make it unique`);
  const next = current.replace(oldString, newString);
  if (Buffer.byteLength(next, "utf8") > MAX_FILE_BYTES) throw new Error("patched SKILL.md exceeds 128 KiB");
  parseFrontmatter(next);
  atomicWrite(skillFile(root, name), next);
  stampUsage(root, name, { patch: true });
  return { ok: true, name, path: skillFile(root, name), lints: lintsFor(name, next) };
}

function writeSupportFile(root, { name, filePath, content }) {
  validateName(name);
  assertManaged(root, name);
  if (!fs.existsSync(skillFile(root, name))) throw new Error(`skill "${name}" not found`);
  const rel = String(filePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = rel.split("/");
  if (!SUPPORT_DIRS.has(parts[0]) || parts.length < 2 || parts.some((p) => p === ".." || p === "")) {
    throw new Error("file_path must be references|templates|scripts/<file>");
  }
  if (typeof content !== "string") throw new Error("content is required");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("support file exceeds 128 KiB");
  const dest = path.join(skillDir(root, name), ...parts);
  assertInsideLearned(root, dest);
  atomicWrite(dest, content.endsWith("\n") ? content : `${content}\n`);
  stampUsage(root, name, { patch: true });
  return { ok: true, name, path: dest, lints: [] };
}

function archiveSkill(root, name) {
  validateName(name);
  assertManaged(root, name);
  const src = skillDir(root, name);
  if (!fs.existsSync(src)) throw new Error(`skill "${name}" not found`);
  const dest = path.join(archiveDir(root), `${name}-${Date.now()}`);
  ensureDir(archiveDir(root));
  fs.renameSync(src, dest);
  const usage = loadUsage(root);
  if (usage[name]) {
    usage[name].archived_at = new Date().toISOString();
    usage[name].archive_path = dest;
    saveUsage(root, usage);
  }
  return { ok: true, name, archived: dest };
}

function restoreSkill(root, name) {
  const usage = loadUsage(root);
  const entry = usage[name];
  const hinted = entry?.archive_path;
  let src = hinted && fs.existsSync(hinted) ? hinted : null;
  if (!src && fs.existsSync(archiveDir(root))) {
    const matches = fs
      .readdirSync(archiveDir(root))
      .filter((d) => d === name || d.startsWith(`${name}-`))
      .sort();
    if (matches.length) src = path.join(archiveDir(root), matches[matches.length - 1]);
  }
  if (!src) throw new Error(`no archive for "${name}"`);
  const dest = skillDir(root, name);
  if (fs.existsSync(dest)) throw new Error(`skill "${name}" already exists`);
  fs.renameSync(src, dest);
  stampUsage(root, name, {});
  return { ok: true, name, path: skillFile(root, name) };
}

function listSkills(root) {
  const usage = loadUsage(root);
  return listManaged(root).map((name) => {
    let description = "";
    try {
      const { fm } = parseFrontmatter(readSkill(root, name));
      description = String(fm.description || "");
    } catch {
      description = "";
    }
    const u = usage[name] || {};
    return {
      name,
      description,
      path: skillFile(root, name),
      created_by: u.created_by || "unknown",
      last_activity_at: u.last_activity_at || null,
      patch_count: u.patch_count || 0,
      pinned: Boolean(u.pinned),
    };
  });
}

function applyOp(root, op, createdBy) {
  const action = String(op?.action || "");
  if (action === "create") return createSkill(root, { name: op.name, content: op.content, createdBy });
  if (action === "patch") {
    return patchSkill(root, { name: op.name, oldString: op.old_string, newString: op.new_string });
  }
  if (action === "write_file") {
    return writeSupportFile(root, { name: op.name, filePath: op.file_path, content: op.content });
  }
  if (action === "delete") return archiveSkill(root, op.name);
  throw new Error(`unknown action "${action}"`);
}

function applyOps(root, ops, createdBy) {
  const results = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    try {
      results.push({ op, result: applyOp(root, op, createdBy) });
    } catch (err) {
      results.push({ op, error: String(err.message || err) });
    }
  }
  return results;
}

function flattenMessage(m) {
  if (!m || typeof m !== "object") return null;
  const role = m.role || m.type || "unknown";
  let content = "";
  const raw = m.content;
  if (typeof raw === "string") content = raw;
  else if (Array.isArray(raw)) {
    content = raw
      .map((p) => {
        if (typeof p === "string") return p;
        if (!p || typeof p !== "object") return "";
        if (typeof p.text === "string") return p.text;
        if (p.type === "toolCall") return `[toolCall ${p.name || ""}] ${JSON.stringify(p.arguments || {}).slice(0, 400)}`;
        if (p.type === "toolResult" || p.type === "text") return String(p.text || p.content || "").slice(0, 1500);
        return JSON.stringify(p).slice(0, 400);
      })
      .filter(Boolean)
      .join("\n");
  } else if (raw && typeof raw === "object") {
    content = JSON.stringify(raw).slice(0, 2000);
  }
  return {
    role: String(role),
    content: content.slice(0, 12000),
    toolName: m.toolName || m.name || undefined,
  };
}

function packMessages(messages, budget = 180000) {
  const out = [];
  let used = 0;
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const flat = flattenMessage(list[i]);
    if (!flat) continue;
    const n = Buffer.byteLength(JSON.stringify(flat), "utf8");
    if (used + n > budget) break;
    out.push(flat);
    used += n;
  }
  out.reverse();
  return { messages: out, truncated: out.length < list.length, chars: used };
}

function selectReviewBodies(root, transcriptBlob, limit = 5) {
  const catalog = listSkills(root);
  const blob = String(transcriptBlob || "").toLowerCase();
  const mentioned = [];
  const rest = [];
  for (const s of catalog) {
    if (s.name && blob.includes(String(s.name).toLowerCase())) mentioned.push(s);
    else rest.push(s);
  }
  rest.sort((a, b) => String(b.last_activity_at || "").localeCompare(String(a.last_activity_at || "")));
  const ordered = mentioned.concat(rest).slice(0, limit);
  const skillBodies = [];
  for (const s of ordered) {
    try {
      skillBodies.push({ name: s.name, content: readSkill(root, s.name).slice(0, 12000) });
    } catch {
      /* ignore */
    }
  }
  return { catalog, skillBodies };
}

function moveFileIfPresent(src, dest) {
  if (!fs.existsSync(src) || fs.existsSync(dest)) return false;
  ensureDir(path.dirname(dest));
  fs.renameSync(src, dest);
  return true;
}

function migrateNestedLearned(root) {
  const nested = path.join(root, "learned");
  const moved = [];
  if (!fs.existsSync(nested)) return { moved };
  moveFileIfPresent(path.join(nested, ".usage.json"), usagePath(root));
  moveFileIfPresent(path.join(nested, ".config.json"), configPath(root));
  const oldQueue = path.join(nested, ".queue");
  if (fs.existsSync(oldQueue)) {
    ensureDir(queueDir(root));
    for (const name of fs.readdirSync(oldQueue)) {
      moveFileIfPresent(path.join(oldQueue, name), path.join(queueDir(root), name));
    }
  }
  const oldArchive = path.join(nested, ".archive");
  if (fs.existsSync(oldArchive)) {
    ensureDir(archiveDir(root));
    for (const name of fs.readdirSync(oldArchive)) {
      moveFileIfPresent(path.join(oldArchive, name), path.join(archiveDir(root), name));
    }
  }
  for (const name of listActive(nested)) {
    const dest = skillDir(root, name);
    const src = skillDir(nested, name);
    let content = "";
    try {
      content = fs.readFileSync(path.join(src, "SKILL.md"), "utf8");
    } catch {
      content = "";
    }
    const thin = content ? structureErrors(content) : ["unreadable"];
    if (thin.length) {
      try {
        fs.rmSync(src, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      continue;
    }
    if (!fs.existsSync(dest)) {
      fs.renameSync(src, dest);
      moved.push(name);
      stampUsage(root, name, { created_by: "agent" });
    } else {
      try {
        fs.rmSync(src, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  for (const leftover of [".config.json", ".usage.json", ".queue", ".archive"]) {
    try {
      fs.rmSync(path.join(nested, leftover), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    const left = fs.readdirSync(nested).filter((n) => n !== "." && n !== "..");
    if (left.length === 0) fs.rmSync(nested, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { moved };
}

module.exports = {
  DEFAULT_CONFIG,
  NAME_RE,
  MAX_ACTIVE,
  MAX_DESC,
  homedir,
  learnedRoot,
  metaDir,
  queueDir,
  archiveDir,
  ensureDir,
  atomicWrite,
  loadConfig,
  saveConfig,
  loadUsage,
  listActive,
  listManaged,
  listSkills,
  readSkill,
  createSkill,
  patchSkill,
  writeSupportFile,
  archiveSkill,
  restoreSkill,
  applyOp,
  applyOps,
  parseFrontmatter,
  lintsFor,
  structureErrors,
  flattenMessage,
  packMessages,
  selectReviewBodies,
  validateName,
  migrateNestedLearned,
};
