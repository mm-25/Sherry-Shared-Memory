import { createHash, randomUUID } from "node:crypto";

const normalize = (value) => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function parseChatGptAxSnapshot(raw) {
  let source = raw;
  if (typeof raw === "string") {
    try { source = JSON.parse(raw); }
    catch { throw new Error("ChatGPT Accessibility snapshot is not valid JSON."); }
  }
  if (source?.kind !== "chatgpt_ax_snapshot_v1" || typeof source.title !== "string"
      || !Array.isArray(source.turns) || source.turns.length > 1000) {
    throw new Error("Unsupported ChatGPT Accessibility snapshot.");
  }
  // The shared desktop shell uses the same speaker headings in Codex views.
  // Text extraction alone is never proof that the selected product is ChatGPT.
  if (source.surface !== "chatgpt") {
    throw new Error("ChatGPT source is unverified. Codex and unknown views are not captured as ChatGPT.");
  }
  if (source.truncated) throw new Error("ChatGPT Accessibility snapshot was truncated; retry before capture.");
  const turns = [];
  for (const turn of source.turns) {
    if (!turn || !["user", "assistant"].includes(turn.role)
        || !Array.isArray(turn.parts) || turn.parts.length > 20_000) {
      throw new Error("ChatGPT Accessibility turn is malformed.");
    }
    const blocks = [];
    let currentBlock = null;
    for (const part of turn.parts) {
      if (!part || !Number.isInteger(part.block) || part.block < 0
          || typeof part.text !== "string" || part.text.length > 250_000) {
        throw new Error("ChatGPT Accessibility text fragment is malformed.");
      }
      if (part.block !== currentBlock) {
        blocks.push("");
        currentBlock = part.block;
      }
      blocks[blocks.length - 1] += part.text;
    }
    const text = normalize(blocks.join(" "));
    if (text) turns.push({ role: turn.role, text });
  }
  if (!turns.some((turn) => turn.role === "user")) {
    throw new Error("ChatGPT Accessibility snapshot has no user turn.");
  }
  return { title: normalize(source.title) || "ChatGPT conversation", turns };
}

function anchorsFor(snapshot) {
  return snapshot.turns.slice(0, 32).map((turn) => ({
    hash: digest(`${turn.role}\0${turn.text}`),
    length: turn.text.length,
    role: turn.role
  }));
}

export function resolveLocalChatGptIdentity(state, snapshot, now = new Date().toISOString()) {
  const records = state.chatgptIdentities ||= [];
  if (!Array.isArray(records) || records.length > 1000) throw new Error("ChatGPT identity registry is invalid or full.");
  const titleKey = digest(normalize(snapshot.title).toLowerCase());
  const anchors = anchorsFor(snapshot);
  const firstUser = anchors.find((anchor) => anchor.role === "user");
  if (anchors.length < 2) {
    throw new Error("ChatGPT desktop chat needs a second visible turn for stable local identity.");
  }
  const uniqueAnchorHashes = [...new Set(anchors.map((anchor) => anchor.hash))];
  const candidates = records.map((record) => {
    if (!record || !Array.isArray(record.anchors) || typeof record.id !== "string") {
      throw new Error("ChatGPT identity registry contains a malformed entry.");
    }
    const overlap = uniqueAnchorHashes.filter((anchor) => record.anchors.includes(anchor)).length;
    const sameTitle = record.titleKey === titleKey;
    const eligible = overlap >= 3 || (sameTitle && overlap >= 2);
    return { record, overlap, eligible };
  }).filter((item) => item.eligible).sort((a, b) => b.overlap - a.overlap);
  if (candidates.length > 1 && candidates[0].overlap === candidates[1].overlap) {
    throw new Error("Multiple ChatGPT desktop conversations match this snapshot; identity needs review.");
  }
  let record = candidates[0]?.record;
  if (!record) {
    if (records.length >= 1000) throw new Error("ChatGPT identity registry is full.");
    record = { id: randomUUID(), titleKey, firstUser: firstUser?.hash || null,
      anchors: [], firstObservedAt: now, lastObservedAt: now };
    records.push(record);
  }
  record.titleKey = titleKey;
  record.lastObservedAt = now;
  record.anchors = [...new Set([...record.anchors, ...uniqueAnchorHashes])].slice(-64);
  return record.id;
}
