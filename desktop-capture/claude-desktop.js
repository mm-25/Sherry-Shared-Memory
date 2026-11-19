import { createHash, randomUUID } from "node:crypto";
import { stableUuid } from "./batches.js";

import { sourceMetadata, eventForServer } from "./source-metadata.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseClaudeAxSnapshot(raw) {
  const snapshot = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (snapshot?.kind !== "claude_ax_snapshot_v1" || snapshot.truncated
      || typeof snapshot.sourceURL !== "string" || !Array.isArray(snapshot.turns)
      || snapshot.turns.length > 1000) throw new Error("Claude Accessibility snapshot is incomplete.");
  if (/^app:\/\/localhost\/epitaxy\/local_/i.test(snapshot.sourceURL)) {
    return { codeView: true, turns: [], title: "Claude Code" };
  }
  const turns = snapshot.turns.map((turn) => {
    if (!["user", "assistant"].includes(turn?.role) || typeof turn.text !== "string"
        || turn.text.length > 250_000) throw new Error("Claude Accessibility turn is malformed.");
    return { role: turn.role, text: turn.text.replace(/\u00a0/g, " ").trim() };
  }).filter((turn) => turn.text);
  if (!turns.some((turn) => turn.role === "user")) throw new Error("Claude snapshot has no user turn.");
  return { codeView: false, sourceURL: snapshot.sourceURL,
    title: typeof snapshot.title === "string" && snapshot.title.trim()
      ? snapshot.title.trim() : "Claude conversation", turns };
}

export function resolveClaudeDesktopIdentity(state, snapshot, now = new Date().toISOString()) {
  const pathMatch = snapshot.sourceURL.match(/(?:^|[\/,_-])([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:$|[/?#])/i);
  if (pathMatch && uuid.test(pathMatch[1])) return pathMatch[1];
  if (snapshot.turns.length < 2) throw new Error("Claude desktop chat needs a second visible turn for stable identity.");
  const records = state.claudeIdentities ||= [];
  if (!Array.isArray(records) || records.length > 1000) throw new Error("Claude identity registry is invalid or full.");
  const anchors = snapshot.turns.slice(0, 32).map((turn) => hash(`${turn.role}\0${turn.text}`));
  const candidates = records.map((record) => ({ record,
    overlap: anchors.filter((anchor) => record.anchors?.includes(anchor)).length }))
    .filter((item) => item.overlap >= 2).sort((a, b) => b.overlap - a.overlap);
  if (candidates.length > 1 && candidates[0].overlap === candidates[1].overlap) {
    throw new Error("Multiple Claude conversations match this view; identity needs review.");
  }
  let record = candidates[0]?.record;
  if (!record) {
    if (records.length >= 1000) throw new Error("Claude identity registry is full.");
    record = { id: randomUUID(), anchors: [], firstObservedAt: now };
    records.push(record);
  }
  record.anchors = [...new Set([...record.anchors, ...anchors])].slice(-64);
  record.lastObservedAt = now;
  return record.id;
}

export function createClaudeDesktopBatches(snapshot, { workspaceId, deviceId,
  capturedAt = new Date().toISOString(), serverCapabilities = {} }) {
  if (!uuid.test(workspaceId || "") || !uuid.test(snapshot.localConversationId || "")) {
    throw new Error("Claude desktop capture needs stable workspace and conversation IDs.");
  }
  const conversationId = `desktop:${snapshot.localConversationId}`;
  const counts = new Map();
  const events = snapshot.turns.map((turn, sequence) => {
    const textHash = hash(`${turn.role}\0${turn.text}`);
    const repeat = counts.get(textHash) || 0;
    counts.set(textHash, repeat + 1);
    const messageId = `local:${textHash.slice(0, 32)}:${repeat}`;
    return { eventId: `evt_${hash(`claude\0${conversationId}\0${messageId}`).slice(0, 40)}`,
      provider: "claude", conversationId, providerMessageId: messageId,
      sequence, role: turn.role, text: turn.text, contentHash: textHash,
      sourceUrl: null, sourceLocator: `claude:desktop:${snapshot.localConversationId}`,
      chatTitle: snapshot.title, messageTimestamp: null, capturedAt, links: [], attachments: [],
      sourceMetadata: sourceMetadata({ titleBasis: /^(?:claude(?: conversation)?|new chat)$/i.test(snapshot.title) ? "generic" : "unknown",
        conversationIdentity: "local", messageIdentity: "local", timestampBasis: "observed" }) };
  });
  const batches = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const basis = { schemaVersion: 2, workspaceId, provider: "claude", providerFamily: "anthropic",
      product: "claude", surface: "desktop", reason: "accessibility", clientCreatedAt: capturedAt,
      captureClient: { type: "accessibility", adapterVersion: "claude-ax-0.1.0",
        deviceId, os: "macos", appVersion: null,
        captureSessionId: `claude:${conversationId}` },
      coverage: { state: "partial", gapBefore: false, backfillAvailable: true }, events: pending };
    batches.push({ ...basis, batchId: stableUuid(JSON.stringify(basis)) });
    pending = [];
  };
  for (const event of events) {
    if (Buffer.byteLength(JSON.stringify([...pending, event])) > 450_000) {
      if (!pending.length) throw new Error("A Claude message exceeds the batch limit.");
      flush();
    }
    pending.push(eventForServer(event, serverCapabilities));
    if (pending.length >= 100) flush();
  }
  flush();
  return batches;
}
