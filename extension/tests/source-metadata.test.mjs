import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import * as sync from "../src/sync-core.js";
const context = vm.createContext({ URL });
vm.runInContext(await readFile(new URL("../src/core.js", import.meta.url), "utf8"), context);
const core = context.SharedMemoryCaptureCore;
const config = { workspaceId: "12345678-1234-4234-8234-123456789012" };
for (const provider of ["chatgpt", "claude", "gemini"]) {
  test(`${provider} distinguishes exposed source title from generic page title and local IDs`, () => {
    assert.equal(core.browserTitle(provider, provider).titleBasis, "generic");
    assert.equal(core.browserTitle(provider, "New chat").titleBasis, "generic");
    assert.equal(core.browserTitle(provider, `A real topic | ${provider}`).titleBasis, "source");
    const metadata = core.browserSourceMetadata({ provider, canonicalConversationId: "real-id", titleBasis: "source", providerMessageId: null, messageTimestamp: null, captureAttachments: false });
    assert.deepEqual(JSON.parse(JSON.stringify(metadata)), { version: 1, titleBasis: "source", conversationIdentity: "provider", messageIdentity: "local", timestampBasis: "observed", linksStatus: "inspected", attachmentsStatus: "not_inspected" });
    assert.equal(core.browserSourceMetadata({ provider, titleBasis: "generic", providerMessageId: "exposed", messageTimestamp: "2026-10-30T10:00:00Z", captureAttachments: true }).conversationIdentity, "local");
  });
}
test("new source evidence is retained locally and sent only with confirmed capability", () => {
  const sourceMetadata = core.browserSourceMetadata({ provider: "gemini", canonicalConversationId: "chat", titleBasis: "source" });
  const event = core.createCapturedEvent({ provider: "gemini", conversationId: "chat", role: "user", text: "Invented", title: "Topic", sourceMetadata });
  assert.equal(event.sourceMetadata.version, 1);
  assert.equal(sync.createCaptureBatches([event], config, "mutation")[0].events[0].sourceMetadata, undefined);
  assert.equal(event.sourceMetadata.version, 1, "local source remains intact");
  assert.equal(sync.createCaptureBatches([event], config, "mutation", { capabilities: { sourceMetadataVersion: 1 } })[0].events[0].sourceMetadata.version, 1);
});
test("metadata-only batching requires both server capabilities and unknown message evidence", () => {
  const observation = { provider: "gemini", conversationId: "chat", chatTitle: "Renamed", capturedAt: "2026-10-30T10:00:00Z", sourceMetadata: { version: 1, titleBasis: "source", conversationIdentity: "provider", messageIdentity: "unknown", timestampBasis: "unknown", linksStatus: "unknown", attachmentsStatus: "unknown" } };
  assert.deepEqual(sync.createConversationMetadataBatches([observation], config), []);
  const batch = sync.createConversationMetadataBatches([observation], config, { capabilities: { sourceMetadataVersion: 1, conversationUpdatesVersion: 1 } })[0];
  assert.deepEqual(batch.events, []);
  assert.equal(batch.conversationUpdates[0].chatTitle, "Renamed");
  assert.equal(batch.conversationUpdates[0].sourceMetadata.timestampBasis, "unknown");
});

test("ChatGPT detects a title-only change with unchanged text and classifies its synthetic turn ID as local", async () => {
  const sent = [], intervals = new Map();
  class Turn {
    innerText = "Invented ChatGPT message";
    matches(selector) { return selector.includes("[data-message-author-role") && !selector.includes("assistant"); }
    getAttribute(name) { return name === "data-message-author-role" ? "user" : name === "data-testid" ? "conversation-turn-0" : null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    contains(other) { return other === this; }
  }
  const turn = new Turn();
  const browser = { storage: { sync: { get: async defaults => defaults } }, runtime: {
    onMessage: { addListener() {} }, sendMessage: async message => { sent.push(message); return { ok: true, result: { added: message.payload?.events?.length || 0, retained: true } }; }
  } };
  const document = { title: "ChatGPT", body: {}, visibilityState: "visible", querySelector: () => null, querySelectorAll: () => [turn] };
  const scope = vm.createContext({ browser, document, location: { href: "https://chatgpt.com/c/existing" }, URL, Element: Turn,
    performance: { now: () => 1 }, MutationObserver: class { observe() {} disconnect() {} },
    setInterval: (fn, delay) => intervals.set(delay, fn), setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(await readFile(new URL("../src/core.js", import.meta.url), "utf8"), scope);
  vm.runInContext(await readFile(new URL("../src/chatgpt-adapter.js", import.meta.url), "utf8"), scope);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  const event = sent.find(message => message.type === "CAPTURE_BATCH").payload.events[0];
  assert.equal(event.sourceMetadata.titleBasis, "generic");
  assert.equal(event.sourceMetadata.messageIdentity, "local");
  assert.equal(event.providerMessageId, "conversation-turn-0");
  document.title = "Source named topic - ChatGPT";
  intervals.get(5000)(); await settle();
  assert.equal(sent.filter(message => message.type === "CAPTURE_BATCH").length, 1);
  const updates = () => sent.filter(message => message.type === "CONVERSATION_METADATA");
  assert.equal(updates().at(-1).payload.chatTitle, "Source named topic");
  assert.equal(updates().at(-1).payload.sourceMetadata.titleBasis, "source");
  const count = updates().length;
  intervals.get(5000)(); await settle();
  assert.equal(updates().length, count);
});

test("all browser providers produce event and title batches accepted by the actual additive server contract", async () => {
  const { validateCaptureBatch } = await import("../../backend/src/validation.js");
  const capabilities = { sourceMetadataVersion: 1, conversationUpdatesVersion: 1 };
  for (const provider of ["chatgpt", "claude", "gemini"]) {
    const url = { chatgpt: "https://chatgpt.com/c/existing", claude: "https://claude.ai/chat/existing", gemini: "https://gemini.google.com/app/existing" }[provider];
    const sourceMetadata = core.browserSourceMetadata({ provider, canonicalConversationId: "existing", titleBasis: "source" });
    const event = core.createCapturedEvent({ provider, conversationId: "existing", role: "user", text: "Invented content", title: "Actual source topic", url, sourceMetadata });
    const eventBatch = sync.createCaptureBatches([event], config, "initial_scan", { capabilities })[0];
    const eventResult = validateCaptureBatch(eventBatch);
    assert.equal(eventResult.ok, true, JSON.stringify(eventResult.errors));
    const observation = { provider, conversationId: "existing", chatTitle: "Renamed", capturedAt: event.capturedAt,
      sourceMetadata: { ...sourceMetadata, messageIdentity: "unknown", timestampBasis: "unknown", linksStatus: "unknown", attachmentsStatus: "unknown" } };
    const metadataBatch = sync.createConversationMetadataBatches([observation], config, { capabilities })[0];
    const result = validateCaptureBatch(metadataBatch);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.value.events.length, 0);
  }
});
