import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stableUuid } from "./batches.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function visibleText(row) {
  const content = row?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text).join("\n").trim();
}

export function parseClaudeCodeJsonl(raw, filename = "") {
  if (filename.includes("/subagents/")) throw new Error("Subagent session is excluded.");
  const diagnostics = { malformedRows: 0, oversizedMessages: 0, skippedNonText: 0 };
  const messages = new Map();
  let sessionId = null;
  let appVersion = null;
  for (const [line, text] of raw.split("\n").entries()) {
    if (!text.trim()) continue;
    let row;
    try { row = JSON.parse(text); }
    catch { diagnostics.malformedRows++; continue; }
    if (!["user", "assistant"].includes(row?.type) || row.isSidechain || row.isMeta) continue;
    if (row.entrypoint && !["cli", "claude-desktop", "claude-desktop-3p"].includes(row.entrypoint)) continue;
    if (row.userType && row.userType !== "external") continue;
    if (row.message?.role && row.message.role !== row.type) continue;
    if (!uuid.test(row.sessionId || "") || !uuid.test(row.uuid || "")) {
      diagnostics.malformedRows++; continue;
    }
    if (!sessionId) sessionId = row.sessionId;
    if (row.sessionId !== sessionId) { diagnostics.malformedRows++; continue; }
    const body = visibleText(row);
    if (!body) { diagnostics.skippedNonText++; continue; }
    if (row.type === "user" && /^<(?:local-command-|command-name|command-message|command-args|system-reminder|function_results|tool_result)/i.test(body)) {
      diagnostics.skippedNonText++; continue;
    }
    if (body.length > 250_000) { diagnostics.oversizedMessages++; continue; }
    const when = Date.parse(row.timestamp);
    if (!Number.isFinite(when)) { diagnostics.malformedRows++; continue; }
    appVersion = typeof row.version === "string" ? row.version : appVersion;
    const key = row.type === "assistant" && typeof row.message?.id === "string"
      ? row.message.id : row.uuid;
    const previous = messages.get(key);
    // Claude may write the same assistant message more than once as it streams.
    // Retain the longest visible text for a stable event ID and final content.
    if (!previous || body.length >= previous.text.length) {
      messages.set(key, { key, role: row.type, text: body,
        timestamp: new Date(when).toISOString(), firstLine: previous?.firstLine ?? line });
    }
  }
  if (!sessionId) throw new Error("No user-owned Claude Code session was found.");
  const ordered = [...messages.values()].sort((a, b) => a.firstLine - b.firstLine);
  const title = ordered.find((item) => item.role === "user")?.text.split("\n")[0].slice(0, 160)
    || `Claude Code session ${sessionId.slice(0, 8)}`;
  const events = ordered.map((item, sequence) => ({
    eventId: `evt_${hash(`claude_code\0${sessionId}\0${item.key}`).slice(0, 40)}`,
    provider: "claude_code", conversationId: sessionId,
    providerMessageId: item.key.slice(0, 512), sequence, role: item.role,
    text: item.text, contentHash: hash(`${item.role}\0${item.text}`),
    sourceUrl: null, sourceLocator: `claude_code:session:${sessionId}`,
    chatTitle: title, messageTimestamp: item.timestamp, links: [], attachments: []
  }));
  return { sessionId, appVersion, events, diagnostics };
}

export async function readClaudeCodeSession(filename) {
  return parseClaudeCodeJsonl(await readFile(filename, "utf8"), filename);
}

export function createClaudeCodeBatches(parsed, { workspaceId, deviceId,
  capturedAt = new Date().toISOString(), gapBefore = false }) {
  if (!uuid.test(workspaceId || "")) throw new Error("Sherry workspace ID must be a UUID.");
  const batches = [];
  let events = [];
  const flush = () => {
    if (!events.length) return;
    const basis = { schemaVersion: 2, workspaceId, provider: "claude_code", providerFamily: "anthropic",
      product: "claude_code", surface: "desktop", reason: "hook", clientCreatedAt: capturedAt,
      captureClient: { type: "structured_hook", adapterVersion: "claude-code-jsonl-0.1.0",
        deviceId, os: "macos", appVersion: parsed.appVersion,
        captureSessionId: parsed.sessionId },
      coverage: { state: "partial", gapBefore: gapBefore || parsed.diagnostics.malformedRows > 0
        || parsed.diagnostics.oversizedMessages > 0, backfillAvailable: true }, events };
    batches.push({ ...basis, batchId: stableUuid(JSON.stringify(basis)) });
    events = [];
  };
  for (const event of parsed.events) {
    const next = { ...event, capturedAt };
    if (Buffer.byteLength(JSON.stringify([...events, next])) > 450_000) {
      if (!events.length) throw new Error("A Claude Code message exceeds the batch limit.");
      flush();
    }
    events.push(next);
    if (events.length >= 100) flush();
  }
  flush();
  return batches;
}
