"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const apply = require("./review-apply.js");
const store = require("./skill-store.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadSample() {
  const src = fs.readFileSync(path.join(__dirname, "skill-store.test.js"), "utf8");
  const m = src.match(/const SAMPLE = `([\s\S]*?)`;/);
  return m ? m[1] : "";
}

describe("review-apply", () => {
  it("extracts fenced JSON", () => {
    const parsed = apply.extractJson("noise\n```json\n{\"decision\":\"skip\",\"reason\":\"x\",\"ops\":[]}\n```\n");
    assert.equal(parsed.decision, "skip");
  });

  it("reads completion.text or content array", () => {
    assert.equal(apply.completionText({ text: "hi" }), "hi");
    assert.equal(apply.completionText({ content: [{ text: "a" }, { text: "b" }] }), "ab");
  });

  it("turns empty update into skip", () => {
    const n = apply.normalizeReview({ decision: "update", ops: [], reason: "none" });
    assert.equal(n.decision, "skip");
  });
});

describe("selectReviewBodies", () => {
  it("prefers names mentioned in the transcript and still fills remaining slots", () => {
    const SAMPLE = loadSample();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "learned-"));
    store.createSkill(root, { name: "deploy-staging", content: SAMPLE, createdBy: "agent" });
    const other = SAMPLE.replace(/deploy-staging/g, "other-flow");
    store.createSkill(root, { name: "other-flow", content: other, createdBy: "agent" });
    const picked = store.selectReviewBodies(root, "we used deploy-staging today", 5);
    assert.equal(picked.skillBodies[0].name, "deploy-staging");
    assert.equal(picked.skillBodies.length, 2);
    assert.match(picked.skillBodies[0].content, /When to Use/);
  });
});
