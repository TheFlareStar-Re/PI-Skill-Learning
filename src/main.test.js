"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("./skill-store.js");
const main = require("../main.js");

function oversizedJob() {
  const messages = [];
  for (let i = 0; i < 85; i += 1) {
    messages.push({
      role: i % 2 ? "assistant" : "user",
      toolName: "bash",
      content: "x".repeat(2400),
    });
  }
  const packed = store.packMessages(messages);
  return {
    workspace: "fixture",
    toolCallCount: 119,
    learnedCatalog: Array.from({ length: 8 }, (_, i) => ({
      name: `skill-${i}`,
      description: "d".repeat(100),
    })),
    skillBodies: Array.from({ length: 5 }, (_, i) => ({
      name: `skill-${i}`,
      content: "y".repeat(12000),
    })),
    ...packed,
  };
}

test("caps the fully composed review prompt before host submission", () => {
  const prompts = require("./review-prompt.js");
  const job = oversizedJob();
  const raw = prompts.packReviewUser(job);
  assert.ok(raw.length > 200000, `fixture must reproduce host overflow: ${raw.length}`);
  const capped = main.capReviewPrompt(raw);
  assert.ok(capped.length <= main.HOST_MESSAGE_CHAR_CAP);
  assert.match(capped, /\[\.\.\.truncated for retry\.\.\.\]/);
  assert.match(capped, /^Workspace: fixture/);
  assert.equal(capped.slice(-200), raw.slice(-200));
});

test("leaves an in-limit review prompt unchanged", () => {
  const prompt = "short review prompt";
  assert.equal(main.capReviewPrompt(prompt), prompt);
  assert.equal(main.capReviewPrompt(""), "");
});

test("retries only timeout and length/context failures with a shrunken prompt", () => {
  const retryable = [
    "plugin completion timed out",
    "messages exceed 200k characters",
    "prompt is too long",
    "input is too large for the context window",
    "maximum context length exceeded",
    "too many tokens in request",
  ];
  for (const message of retryable) {
    assert.equal(main.shouldRetryWithShrink(new Error(message)), true, message);
  }

  const notRetryable = [
    "newapi API error (400): unknown provider",
    "Connection error.",
    "review output had no JSON object",
    "The model returned no text.",
    "rate limit exceeded",
    "authentication failed",
  ];
  for (const message of notRetryable) {
    assert.equal(main.shouldRetryWithShrink(new Error(message)), false, message);
  }
});
