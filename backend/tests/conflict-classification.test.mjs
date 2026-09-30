import assert from "node:assert/strict";
import test from "node:test";
import { classifyConflict } from "../src/conflict-classification.js";

const claim = (display_text) => ({ display_text });

test("exact restatements and additive detail do not force a conflict choice", () => {
  assert.equal(classifyConflict(claim("User prefers short replies."), claim("User prefers short replies")).kind, "restatement");
  assert.equal(classifyConflict(claim("The user prefers short replies."), claim("User prefers short replies")).kind, "restatement");
  assert.equal(classifyConflict(claim("User prefers short replies for project updates"), claim("User prefers short replies for project updates with clear next steps")).kind, "refinement");
});

test("reversals and ambiguous wording remain available for review", () => {
  assert.equal(classifyConflict(claim("User prefers short replies for project updates"), claim("User prefers short replies for project updates only at work")).kind, "needs_review");
  assert.equal(classifyConflict(claim("User prefers short replies for project updates"), claim("User now prefers detailed replies for project updates")).kind, "needs_review");
  assert.equal(classifyConflict(null, claim("User prefers short replies")).kind, "missing_claim");
});

test("near-identical long statements do not create repetitive choices", () => {
  const earlier = "User is struggling to imagine the broader range of AI interactions that could exist beyond conversational agent style AI like ChatGPT and Claude";
  const newer = "User struggles to imagine the broader range of AI interactions that could exist beyond conversational agent style AI like ChatGPT and Claude";
  assert.equal(classifyConflict(claim(earlier), claim(newer)).kind, "restatement");
});

test("a small but meaningful reversal is never treated as a restatement", () => {
  const earlier = "User prefers short answers when discussing the design research project and wants clear next steps for each review";
  const newer = "User now prefers detailed answers when discussing the design research project and wants clear next steps for each review";
  assert.equal(classifyConflict(claim(earlier), claim(newer)).kind, "needs_review");
  assert.equal(classifyConflict(
    claim("User expects 2 examples when discussing the design research project and wants clear next steps for each review"),
    claim("User expects 3 examples when discussing the design research project and wants clear next steps for each review")
  ).kind, "needs_review");
});
