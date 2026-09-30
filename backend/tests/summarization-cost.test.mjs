import assert from "node:assert/strict";
import test from "node:test";
import { estimateSummarizationCostUsd } from "../src/summarization-cost.js";

test("estimates known Haiku 4.5 usage using published base and cache-read rates", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 100_000 };
  assert.equal(estimateSummarizationCostUsd("anthropic", "claude-haiku-4-5-20251001", usage), 1.51);
});

test("leaves unknown models and invalid usage unpriced", () => {
  assert.equal(estimateSummarizationCostUsd("anthropic", "future-model", { inputTokens: 100, outputTokens: 10 }), null);
  assert.equal(estimateSummarizationCostUsd("anthropic", "claude-haiku-4-5", { inputTokens: -1, outputTokens: 10 }), null);
});
