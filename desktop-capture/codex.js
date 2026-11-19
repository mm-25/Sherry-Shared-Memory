import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";

import { sourceMetadata } from "./source-metadata.js";

const uuidInFilename = /([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function visibleText(payload) {
  if (!Array.isArray(payload.content)) return "";
  const role = payload.role;
  const allowedType = role === "user" ? "input_text" : "output_text";
  let kinds;
  if (role === "user") {
    kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
    // Codex also records environment context and replayed internal context as
    // user-role messages. Capture only parts explicitly marked user.text.
    if (!Array.isArray(kinds) || kinds.length !== payload.content.length) return "";
  }
  return payload.content
    .filter((part, index) => part && part.type === allowedType && typeof part.text === "string"
      && (role !== "user" || kinds[index] === "user.text"))
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export const CODEX_MAX_ROW_BYTES = 16 * 1024 * 1024;

function createParser(filename) {
  const diagnostics = { malformedRows: 0, skippedUserContext: 0, skippedAssistantPhases: 0, oversizedMessages: 0, oversizedRows: 0 };
  let sessionId = basename(filename).match(uuidInFilename)?.[1] || null;
  let sessionTimestamp = null;
  let appVersion = null;
  let userOwnedSession = false;
  const messages = [];

  function accept(line, lineIndex) {
    if (!line.trim()) return;
    let row;
    try { row = JSON.parse(line); }
    catch { diagnostics.malformedRows += 1; return; }
    const payload = row?.payload;
    if (row.type === "session_meta" && payload && typeof payload === "object") {
      sessionId = payload.id || payload.session_id || sessionId;
      sessionTimestamp = timestamp(row.timestamp || payload.timestamp) || sessionTimestamp;
      appVersion = typeof payload.cli_version === "string" ? payload.cli_version : appVersion;
      userOwnedSession = payload.thread_source === "user" && typeof payload.source === "string";
      return;
    }
    if (row.type !== "response_item" || payload?.type !== "message") return;
    if (!sessionId || !["user", "assistant"].includes(payload.role)) return;
    if (payload.role === "assistant" && !["final_answer", "final"].includes(payload.phase)) {
      diagnostics.skippedAssistantPhases += 1;
      return;
    }
    const text = visibleText(payload);
    if (!text) {
      if (payload.role === "user") diagnostics.skippedUserContext += 1;
      return;
    }
    if (text.length > 250_000) {
      diagnostics.oversizedMessages += 1;
      return;
    }
    const originalTime = timestamp(row.timestamp)
      || timestamp(payload.internal_chat_message_metadata_passthrough?.create_time);
    const when = originalTime || sessionTimestamp;
    if (!when) { diagnostics.malformedRows += 1; return; }
    const stableMessageKey = typeof payload.id === "string" && payload.id
      ? payload.id : `line:${lineIndex}`;
    messages.push({
      key: stableMessageKey,
      role: payload.role,
      text,
      timestamp: when,
      timestampBasis: originalTime ? "source" : "session_fallback",
      messageIdentity: typeof payload.id === "string" && payload.id ? "provider" : "local"
    });
  }
  function finish() {
    if (!sessionId) throw new Error("No stable Codex session ID was found.");
    if (!userOwnedSession) throw new Error("This is not a verified user-owned Codex session; subagent and review sessions are excluded.");
    const title = messages.find((message) => message.role === "user")?.text.split("\n")[0].slice(0, 160)
      || `Codex session ${sessionId.slice(0, 8)}`;
    const events = messages.map((message, sequence) => ({
      eventId: `evt_${hash(`codex\0${sessionId}\0${message.key}`).slice(0, 40)}`,
      provider: "codex",
      conversationId: sessionId,
      providerMessageId: message.key.slice(0, 512),
      sequence,
      role: message.role,
      text: message.text,
      contentHash: hash(`${message.role}\0${message.text}`),
      sourceUrl: null,
      sourceLocator: `codex:session:${sessionId}`,
      chatTitle: title,
      messageTimestamp: message.timestamp,
      links: [],
      attachments: [],
      sourceMetadata: sourceMetadata({ titleBasis: messages.some((item) => item.role === "user") ? "derived" : "generic",
        conversationIdentity: "provider", messageIdentity: message.messageIdentity, timestampBasis: message.timestampBasis })
    }));
    return { sessionId, appVersion, events, diagnostics };
  }
  return { accept, finish, diagnostics };
}

export function parseCodexJsonl(contents, filename = "session.jsonl") {
  const parser = createParser(filename);
  for (const [index,line] of String(contents).split("\n").entries()) parser.accept(line,index);
  return parser.finish();
}

export async function readCodexSession(filename) {
  const parser = createParser(filename);
  let parts = [], bytes = 0, oversized = false, lineIndex = 0;
  const append = (part) => {
    if (oversized) return;
    if (bytes + part.length > CODEX_MAX_ROW_BYTES) {
      oversized = true; parts = []; bytes = 0;
    } else if (part.length) { parts.push(part); bytes += part.length; }
  };
  const finishLine = () => {
    if (oversized) parser.diagnostics.oversizedRows += 1;
    else parser.accept(Buffer.concat(parts, bytes).toString("utf8"), lineIndex);
    lineIndex += 1; parts = []; bytes = 0; oversized = false;
  };
  // Never concatenate the complete log or an unbounded line into one string.
  for await (const chunk of createReadStream(filename, {highWaterMark: 64 * 1024})) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      append(chunk.subarray(start, end));
      if (newline < 0) break;
      finishLine(); start = newline + 1;
    }
  }
  if (oversized || bytes) finishLine();
  return parser.finish();
}
