import assert from "node:assert/strict";
import test from "node:test";
import {
  createCaptureBatches,
  createConversationRepairBatches,
  isPermanentUploadStatus,
  normalizeIngestionEndpoint,
  retryDelayMs,
  sanitizeCaptureEvent,
  selectConversationCaptures,
  syncLimits,
  trimUploadQueue,
  uploadFailureAction
} from "../src/sync-core.js";

const workspaceId = "7c895c18-05e4-4f96-9148-37ad93b2a789";

test("normalizes a Worker base URL to the versioned capture endpoint", () => {
  assert.equal(
    normalizeIngestionEndpoint("https://memory.example/"),
    "https://memory.example/v1/capture/batches"
  );
  assert.equal(
    normalizeIngestionEndpoint("https://memory.example/v1/capture/batches"),
    "https://memory.example/v1/capture/batches"
  );
});

test("allows local HTTP development but rejects remote insecure endpoints", () => {
  assert.equal(normalizeIngestionEndpoint("http://localhost:8787"), "http://localhost:8787/v1/capture/batches");
  assert.throws(() => normalizeIngestionEndpoint("http://memory.example"), /must use HTTPS/);
});

test("splits batches at the server event limit and preserves provider groups", () => {
  const events = Array.from({ length: 101 }, (_, index) => ({ provider: "chatgpt", eventId: `evt_${index}` }));
  let id = 0;
  const batches = createCaptureBatches(events, { workspaceId }, "backfill", {
    createId: () => `batch-${id += 1}`,
    now: () => "2026-09-14T14:00:00.000Z"
  });
  assert.equal(batches.length, 2);
  assert.equal(batches[0].events.length, syncLimits.maxEventsPerBatch);
  assert.equal(batches[1].events.length, 1);
  assert.equal(batches[0].schemaVersion, 2);
  assert.equal(batches[0].providerFamily, "openai");
  assert.equal(batches[0].product, "chatgpt");
  assert.equal(batches[0].surface, "web");
  assert.equal(batches[0].captureClient.type, "browser_dom");
  assert.equal(batches[0].coverage.state, "complete_observed_range");
});

test("repair upload selects only local captures from the open conversation", () => {
  const events = [
    { provider: "gemini", conversationId: "affected", eventId: "evt_1" },
    { provider: "gemini", conversationId: "other", eventId: "evt_2" },
    { provider: "chatgpt", conversationId: "affected", eventId: "evt_3" },
    { provider: "gemini", conversationId: "affected", eventId: "evt_4" }
  ];
  assert.deepEqual(selectConversationCaptures(events, "gemini", "affected").map((event) => event.eventId), ["evt_1", "evt_4"]);
  assert.throws(() => selectConversationCaptures(events, "gemini", ""), /supported conversation/);
  const batches = createConversationRepairBatches(events, { workspaceId }, "gemini", "affected", {
    createId: () => "repair-batch",
    now: () => "2026-10-01T14:00:00.000Z"
  });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].reason, "repair_backfill");
  assert.deepEqual(batches[0].events.map((event) => event.eventId), ["evt_1", "evt_4"]);
});

test("uses bounded exponential retry delays", () => {
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(2), 60_000);
  assert.equal(retryDelayMs(99), 1_920_000);
});

test("distinguishes permanent client errors from temporary service failures", () => {
  assert.equal(isPermanentUploadStatus(401), false);
  assert.equal(isPermanentUploadStatus(422), true);
  assert.equal(isPermanentUploadStatus(503), false);
  assert.equal(isPermanentUploadStatus(0), false);
});

test("sanitizes invalid link and attachment metadata before upload", () => {
  const event = sanitizeCaptureEvent({
    links: ["https://example.com/a", "/relative", "javascript:alert(1)", "https://example.com/a"],
    attachments: [{ name: "valid" }, null, "invalid"]
  });
  assert.deepEqual(event.links, ["https://example.com/a"]);
  assert.deepEqual(event.attachments, [{ name: "valid" }]);
});

test("repairs impossible historical sequence values before upload", () => {
  const event = sanitizeCaptureEvent({
    provider: "chatgpt",
    conversationId: "conversation-1",
    sequence: 9_999_999,
    links: [],
    attachments: []
  }, 7);
  assert.equal(event.sequence, 7);
});

test("routes auth, validation, permission, and temporary failures safely", () => {
  assert.equal(uploadFailureAction(401), "refresh_session");
  assert.equal(uploadFailureAction(403), "block");
  assert.equal(uploadFailureAction(422), "quarantine");
  assert.equal(uploadFailureAction(503), "retry");
});

test("bounds the local upload queue", () => {
  const queue = Array.from({ length: 110 }, (_, index) => index);
  const trimmed = trimUploadQueue(queue);
  assert.equal(trimmed.length, syncLimits.maxQueueBatches);
  assert.equal(trimmed[0], 0);
  assert.equal(trimmed.at(-1), 99);
});
