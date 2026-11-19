import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stableUuid } from "./batches.js";

import { sourceMetadata, eventForServer } from "./source-metadata.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAntigravityTranscript(raw, conversationId) {
  if (!uuid.test(conversationId || "")) throw new Error("Antigravity conversation folder is not a UUID.");
  const messages = new Map();
  const diagnostics = { malformedRows: 0, oversizedMessages: 0, skippedInternal: 0 };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { diagnostics.malformedRows++; continue; }
    const role = row.type === "USER_INPUT" && row.source === "USER_EXPLICIT" ? "user"
      : row.type === "PLANNER_RESPONSE" && row.source === "MODEL" ? "assistant" : null;
    if (!role || row.status !== "DONE") { diagnostics.skippedInternal++; continue; }
    const body = typeof row.content === "string" ? row.content.trim() : "";
    if (!body || row.truncated_fields?.length) { diagnostics.skippedInternal++; continue; }
    if (body.length > 250_000) { diagnostics.oversizedMessages++; continue; }
    if (!Number.isInteger(row.step_index) || row.step_index < 0
        || !Number.isFinite(Date.parse(row.created_at))) { diagnostics.malformedRows++; continue; }
    const key = `${row.step_index}:${role}`;
    messages.set(key, { key, step: row.step_index, role, text: body,
      timestamp: new Date(row.created_at).toISOString() });
  }
  const ordered = [...messages.values()].sort((a, b) => a.step - b.step);
  const title = ordered.find((event) => event.role === "user")?.text.split("\n")[0].slice(0, 160)
    || `Antigravity conversation ${conversationId.slice(0, 8)}`;
  const events = ordered.map((message, sequence) => ({
    eventId: `evt_${hash(`antigravity\0${conversationId}\0${message.key}`).slice(0, 40)}`,
    provider: "antigravity", conversationId, providerMessageId: message.key,
    sequence, role: message.role, text: message.text,
    contentHash: hash(`${message.role}\0${message.text}`), sourceUrl: null,
    sourceLocator: `antigravity:conversation:${conversationId}`, chatTitle: title,
    messageTimestamp: message.timestamp, links: [], attachments: [],
    sourceMetadata: sourceMetadata({ titleBasis: ordered.some((item) => item.role === "user") ? "derived" : "generic",
      conversationIdentity: "provider", messageIdentity: "local", timestampBasis: "source" })
  }));
  return { conversationId, events, diagnostics };
}

export async function readAntigravityTranscript(filename, conversationId) {
  return parseAntigravityTranscript(await readFile(filename, "utf8"), conversationId);
}

export function createAntigravityBatchTemplate(parsed, { workspaceId, deviceId,
  capturedAt = new Date().toISOString(), gapBefore = false }) {
  if (!uuid.test(workspaceId || "")) throw new Error("Sherry workspace ID must be a UUID.");
  return { schemaVersion: 2, workspaceId, provider: "antigravity", providerFamily: "google",
      product: "antigravity", surface: "ide", reason: "hook", clientCreatedAt: capturedAt,
      captureClient: { type: "structured_hook", adapterVersion: "antigravity-transcript-0.1.0",
        deviceId, os: "macos", appVersion: null,
        captureSessionId: parsed.conversationId },
      coverage: { state: "partial", gapBefore: gapBefore || parsed.diagnostics.malformedRows > 0
        || parsed.diagnostics.oversizedMessages > 0, backfillAvailable: true } };
}

export function createAntigravityBatches(parsed, {
  capturedAt = new Date().toISOString(), serverCapabilities = {}, ...options
}) {
  const template = createAntigravityBatchTemplate(parsed, { ...options, capturedAt });
  const batches = [];
  let events = [];
  const flush = () => {
    if (!events.length) return;
    const basis = { ...template, events };
    batches.push({ ...basis, batchId: stableUuid(JSON.stringify(basis)) });
    events = [];
  };
  for (const event of parsed.events) {
    const next = { ...eventForServer(event, serverCapabilities), capturedAt };
    if (Buffer.byteLength(JSON.stringify([...events, next])) > 450_000) {
      if (!events.length) throw new Error("An Antigravity message exceeds the batch limit.");
      flush();
    }
    events.push(next);
    if (events.length >= 100) flush();
  }
  flush();
  return batches;
}
