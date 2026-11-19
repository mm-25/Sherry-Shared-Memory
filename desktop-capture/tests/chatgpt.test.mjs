import assert from "node:assert/strict";
import test from "node:test";
import { createChatGptBatches } from "../chatgpt.js";
import { validateCaptureBatch } from "../../backend/src/validation.js";

const conversationId = "a73cd68b-bd48-46ea-a2fe-b61238d23d09";
const workspaceId = "f240c121-52d7-45dd-a2d3-8c4743e77955";
const options = { workspaceId, deviceId: "device_test12345", capturedAt: "2026-10-01T12:00:00.000Z" };
const snapshot = {
  sourceUrl: `https://chatgpt.com/c/${conversationId}`,
  title: "Garden plan",
  turns: [
    { messageId: "user-turn-123", role: "user", text: "Plan a garden" },
    { messageId: "assistant-turn-456", role: "assistant", text: "Plant lavender.", links: ["https://example.com/plants"] }
  ]
};

test("verified ChatGPT desktop turns produce Capture API v2 batches with stable IDs", () => {
  const first = createChatGptBatches(snapshot, options);
  const again = createChatGptBatches(structuredClone(snapshot), options);
  assert.deepEqual(first, again);
  assert.equal(first.length, 1);
  assert.equal(first[0].captureClient.type, "accessibility");
  assert.equal(first[0].coverage.state, "partial");
  assert.equal(first[0].events[0].conversationId, conversationId);
  assert.equal(first[0].events[0].messageTimestamp, null);
  assert.equal(validateCaptureBatch(first[0]).ok, true);
  const revised = createChatGptBatches({
    ...snapshot,
    turns: [snapshot.turns[0], { ...snapshot.turns[1], text: "Plant lavender and thyme." }]
  }, options);
  assert.equal(first[0].events[1].eventId, revised[0].events[1].eventId);
  assert.notEqual(first[0].events[1].contentHash, revised[0].events[1].contentHash);
});

test("ChatGPT desktop mapping refuses ambiguous identity and temporary chats", () => {
  assert.throws(() => createChatGptBatches({ ...snapshot, conversationId: "different-chat-id" }, options), /stable, matching/);
  assert.throws(() => createChatGptBatches({ ...snapshot, sourceUrl: null }, options), /persistent local conversation ID/);
  assert.throws(() => createChatGptBatches({ ...snapshot, temporary: true }, options), /Temporary/);
});

test("native observations can use a local identity without blocking capture", () => {
  const local = {
    sourceUrl: null,
    localConversationId: "observed-chat-001",
    title: "Garden plan",
    turns: [
      { role: "user", text: "Plan a garden" },
      { role: "assistant", text: "Plant lavender." },
      { role: "user", text: "Plan a garden" }
    ]
  };
  const first = createChatGptBatches(local, options);
  const again = createChatGptBatches(structuredClone(local), options);
  assert.deepEqual(first, again);
  assert.equal(first[0].events[0].conversationId, "desktop:observed-chat-001");
  assert.equal(first[0].events[0].sourceUrl, null);
  assert.notEqual(first[0].events[0].eventId, first[0].events[2].eventId);
  assert.equal(first[0].coverage.state, "partial");
  assert.equal(validateCaptureBatch(first[0]).ok, true);
});
