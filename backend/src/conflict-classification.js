// This intentionally recognizes only obvious restatements. Ambiguous pairs stay in review.
function normalizedWords(value) {
  const words = String(value || "").toLowerCase().replace(/[’']/g, "").match(/[a-z0-9]+/g) || [];
  return words[0] === "the" ? words.slice(1) : words;
}

const reversalWords = new Set(["not", "no", "never", "without", "instead", "only", "cannot", "cant", "wont", "doesnt", "didnt", "isnt", "hasnt", "stopped", "former", "previously", "now", "then", "may", "might", "possibly", "perhaps", "considering"]);
const oppositeWords = [
  ["short", "detailed"], ["more", "less"], ["higher", "lower"],
  ["increase", "decrease"], ["private", "public"], ["enabled", "disabled"],
  ["include", "exclude"], ["included", "excluded"], ["like", "dislike"],
  ["continue", "stop"], ["yes", "no"], ["true", "false"]
];

function safeNearRestatement(left, right) {
  const a = new Set(left.filter((word) => word.length > 2 || /^\d+$/.test(word)));
  const b = new Set(right.filter((word) => word.length > 2 || /^\d+$/.test(word)));
  if (Math.min(a.size, b.size) < 8) return false;
  for (const word of reversalWords) if (a.has(word) !== b.has(word)) return false;
  for (const [first, second] of oppositeWords) {
    if ((a.has(first) && b.has(second)) || (a.has(second) && b.has(first))) return false;
  }
  const numbersA = [...a].filter((word) => /^\d+$/.test(word)).sort();
  const numbersB = [...b].filter((word) => /^\d+$/.test(word)).sort();
  if (numbersA.join(",") !== numbersB.join(",")) return false;
  const shared = [...a].filter((word) => b.has(word)).length;
  const union = a.size + b.size - shared;
  return shared / Math.min(a.size, b.size) >= 0.86 && shared / union >= 0.68;
}

export function classifyConflict(leftClaim, rightClaim) {
  if (!leftClaim || !rightClaim) return { kind: "missing_claim", reason: "One memory is no longer available." };
  const left = normalizedWords(leftClaim.display_text || leftClaim.value);
  const right = normalizedWords(rightClaim.display_text || rightClaim.value);
  if (!left.length || !right.length) return { kind: "needs_review", reason: "The wording needs review." };
  const leftText = left.join(" ");
  const rightText = right.join(" ");
  if (leftText === rightText) return { kind: "restatement", reason: "These memories say the same thing." };
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  const shortText = shorter.join(" ");
  const longText = longer.join(" ");
  const extraWords = longText.startsWith(`${shortText} `)
    ? longer.slice(shorter.length)
    : longText.endsWith(` ${shortText}`)
      ? longer.slice(0, longer.length - shorter.length)
      : null;
  if (shorter.length >= 5 && extraWords?.length && extraWords.length <= 24 && !extraWords.some((word) => reversalWords.has(word))) {
    return { kind: "refinement", reason: "One memory adds detail without changing the other." };
  }
  if (safeNearRestatement(left, right)) {
    return { kind: "restatement", reason: "The wording is nearly the same; no choice is needed." };
  }
  return { kind: "needs_review", reason: "These memories may differ; compare their sources before deciding." };
}
