"use strict";

function completionText(completion) {
  if (completion == null) return "";
  if (typeof completion === "string") return completion;
  if (typeof completion.text === "string") return completion.text;
  if (typeof completion.content === "string") return completion.content;
  if (Array.isArray(completion.content)) {
    return completion.content.map((p) => (p && (p.text || p.content)) || "").join("");
  }
  if (completion.message) return completionText(completion.message);
  if (typeof completion.output === "string") return completion.output;
  try {
    return JSON.stringify(completion);
  } catch {
    return String(completion);
  }
}

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("review output was empty");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("review output had no JSON object");
  return JSON.parse(body.slice(start, end + 1));
}

function shrinkReviewUser(user, maxChars) {
  const text = String(user || "");
  const cap = Number(maxChars) || 40000;
  if (text.length <= cap) return text;
  const head = text.slice(0, Math.floor(cap * 0.35));
  const tail = text.slice(-Math.floor(cap * 0.6));
  return `${head}\n\n[...truncated for retry...]\n\n${tail}`;
}

function normalizeReview(parsed) {
  const decision = parsed && parsed.decision === "update" ? "update" : "skip";
  const ops = decision === "update" && Array.isArray(parsed.ops) ? parsed.ops : [];
  if (decision === "update" && ops.length === 0) {
    return { decision: "skip", reason: parsed.reason || "update with empty ops", ops: [] };
  }
  return { decision, reason: parsed && parsed.reason, ops };
}

module.exports = {
  completionText,
  extractJson,
  shrinkReviewUser,
  normalizeReview,
};
