// Published Claude Haiku 4.5 API rates, checked September 30, 2026.
// Keep unknown models null instead of presenting a stale or invented estimate.
const HAIKU_45 = {
  inputPerMillion: 1,
  outputPerMillion: 5,
  cacheReadPerMillion: 0.10
};

export function estimateSummarizationCostUsd(provider, model, usage) {
  if (provider !== "anthropic" || !["claude-haiku-4-5", "claude-haiku-4-5-20251001"].includes(model)) return null;
  const input = Number(usage?.inputTokens);
  const output = Number(usage?.outputTokens);
  const cached = Number(usage?.cachedInputTokens || 0);
  if (![input, output, cached].every((value) => Number.isFinite(value) && value >= 0)) return null;
  return Number(((input * HAIKU_45.inputPerMillion
    + output * HAIKU_45.outputPerMillion
    + cached * HAIKU_45.cacheReadPerMillion) / 1_000_000).toFixed(6));
}
