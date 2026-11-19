import { createHash } from "node:crypto";
import { localDeviceId, stableUuid } from "./batches.js";

const MAX_BATCH_BYTES = 450_000;
const MAX_EVENTS = 100;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MESSAGE_ID = /^[A-Za-z0-9:_-]{8,200}$/;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalUrl(value) {
  if (value == null || value === "") return null;
  let url;
  try { url = new URL(value); }
  catch { throw new Error("ChatGPT conversation URL is invalid."); }
  if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname)) {
    throw new Error("ChatGPT conversation URL must use an official HTTPS host.");
  }
  const id = url.pathname.match(/^\/c\/([^/]+)\/?$/)?.[1];
  if (!id || !CONVERSATION_ID.test(id)) throw new Error("ChatGPT conversation URL has no stable conversation ID.");
  return { url: url.href, id };
}

function isoOrNull(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("ChatGPT message timestamp must be an ISO timestamp or null.");
  }
  return new Date(value).toISOString();
}

export function createChatGptBatches(snapshot, {
  workspaceId, deviceId = localDeviceId(), capturedAt = new Date().toISOString(),
  gapBefore = false
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId || "")) {
    throw new Error("SHERRY_WORKSPACE_ID must be a UUID.");
  }
  if (typeof capturedAt !== "string" || !Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("Capture time must be an ISO timestamp.");
  }
  const source = canonicalUrl(snapshot?.sourceUrl);
  const localConversationId = snapshot?.localConversationId;
  if (source && snapshot?.conversationId && source.id !== snapshot.conversationId) {
    throw new Error("ChatGPT snapshot needs a stable, matching conversation ID.");
  }
  if (!source && (typeof localConversationId !== "string" || !CONVERSATION_ID.test(localConversationId))) {
    throw new Error("ChatGPT desktop snapshot needs a persistent local conversation ID.");
  }
  const conversationId = source?.id || `desktop:${localConversationId}`;
  if (!Array.isArray(snapshot?.turns) || snapshot.turns.length > 100_000) {
    throw new Error("ChatGPT snapshot needs a bounded turns array.");
  }
  const title = typeof snapshot.title === "string" ? snapshot.title.trim() : "";
  if (!title || title.length > 1000) throw new Error("ChatGPT snapshot needs a conversation title.");
  if (snapshot.temporary === true) throw new Error("Temporary ChatGPT conversations are not enabled for capture.");
  if (snapshot.appVersion != null && (typeof snapshot.appVersion !== "string" || snapshot.appVersion.length > 200)) {
    throw new Error("ChatGPT app version must be a string of at most 200 characters.");
  }

  const events = [];
  const seen = new Set();
  const identicalTextCounts = new Map();
  for (const [sequence, turn] of snapshot.turns.entries()) {
    if (!turn || !["user", "assistant"].includes(turn.role)) {
      throw new Error("ChatGPT turns must have a verified user or assistant role.");
    }
    const text = typeof turn.text === "string" ? turn.text.trim() : "";
    if (!text || text.length > 250_000) continue;
    const providedMessageId = typeof turn.messageId === "string" ? turn.messageId.trim() : "";
    if (providedMessageId && !MESSAGE_ID.test(providedMessageId)) {
      throw new Error("ChatGPT message ID has an unsupported format.");
    }
    const textKey = hash(`${turn.role}\0${text}`);
    const identicalIndex = identicalTextCounts.get(textKey) || 0;
    identicalTextCounts.set(textKey, identicalIndex + 1);
    const messageId = providedMessageId || `local:${textKey.slice(0, 32)}:${identicalIndex}`;
    if (seen.has(messageId)) throw new Error("ChatGPT message IDs must be unique within a snapshot.");
    seen.add(messageId);
    if (turn.links != null && !Array.isArray(turn.links)) throw new Error("ChatGPT links must be an array.");
    const links = [...new Set(turn.links || [])];
    if (links.length > 50 || links.some((link) => {
      if (typeof link !== "string") return true;
      try { return new URL(link).protocol !== "https:"; }
      catch { return true; }
    })) throw new Error("ChatGPT links must be HTTPS URLs.");
    events.push({
      eventId: `evt_${hash(`chatgpt\0${conversationId}\0${messageId}`).slice(0, 40)}`,
      provider: "chatgpt",
      conversationId,
      providerMessageId: messageId,
      sequence,
      role: turn.role,
      text,
      contentHash: hash(`${turn.role}\0${text}`),
      sourceUrl: source?.url || null,
      sourceLocator: source ? `chatgpt:conversation:${conversationId}`
        : `chatgpt:desktop:${localConversationId}`,
      chatTitle: title,
      messageTimestamp: isoOrNull(turn.timestamp),
      capturedAt,
      links,
      attachments: []
    });
  }

  const batches = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const basis = {
      schemaVersion: 2,
      workspaceId,
      provider: "chatgpt",
      providerFamily: "openai",
      product: "chatgpt",
      surface: "desktop",
      reason: "accessibility",
      clientCreatedAt: capturedAt,
      captureClient: {
        type: "accessibility",
        adapterVersion: "chatgpt-ax-poc-0.1.0",
        deviceId,
        os: "macos",
        appVersion: snapshot.appVersion || null,
        captureSessionId: `chatgpt:${conversationId}`
      },
      coverage: { state: "partial", gapBefore, backfillAvailable: true },
      events: pending
    };
    batches.push({ ...basis, batchId: stableUuid(JSON.stringify(basis)) });
    pending = [];
  };
  for (const event of events) {
    const candidate = [...pending, event];
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_BATCH_BYTES) {
      if (!pending.length) throw new Error(`ChatGPT message ${event.providerMessageId} is too large for one batch.`);
      flush();
    }
    pending.push(event);
    if (pending.length >= MAX_EVENTS) flush();
  }
  flush();
  return batches;
}
