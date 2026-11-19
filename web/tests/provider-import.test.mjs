import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { validateCaptureBatch } from "../../backend/src/validation.js";
import { redactCaptureBatch, redactText } from "../../backend/src/redaction.js";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const claude = await readFile(new URL("../claude-import.js", import.meta.url), "utf8");
const integrity = await readFile(new URL("../import-integrity.js", import.meta.url), "utf8");
const normalization = app.slice(app.indexOf("function importTimestamp(value) {"), app.indexOf("async function previewClaudeImport(file) {"));
const upload = app.slice(app.indexOf("async function uploadImportedConversation("), app.indexOf("async function importProviderHistory("));

function harness(api) {
  const context = { Date, URL, TextEncoder, crypto: webcrypto, workspace: { id: "c76f1a5c-5275-444b-86ed-58c63536f6a0" }, api };
  vm.createContext(context);
  vm.runInContext(`${claude}\n${integrity}\n${normalization}\n${upload}`, context);
  return context;
}

// The network boundary is synthetic. Production normalization, batching,
// validation, redaction and readback run unchanged against invented exports.
for (const provider of ["chatgpt", "claude", "gemini"]) {
  test(`${provider} synthetic import and same-file reimport preserve exact redacted text, dates, roles and turns`, async () => {
    const stored = new Map();
    const outcomes = [];
    const context = harness(async (path, request) => {
      assert.equal(path, "/v1/capture/batches");
      const payload = JSON.parse(request.body);
      assert.equal(request.headers["idempotency-key"], payload.batchId);
      const validation = validateCaptureBatch(payload);
      assert.equal(validation.ok, true, JSON.stringify(validation.errors));
      const { batch } = redactCaptureBatch(validation.value);
      let inserted = 0;
      let duplicates = 0;
      for (const event of batch.events) {
        const prior = stored.get(event.providerMessageId);
        if (prior) {
          assert.equal(event.eventId, prior.eventId);
          duplicates += 1;
        } else inserted += 1;
        stored.set(event.providerMessageId, event);
      }
      outcomes.push({ inserted, duplicates });
      return { ok: true, batchId: batch.batchId, result: { status: "committed", received: batch.events.length, inserted, updated: 0, duplicates } };
    });
    let chats;
    if (provider === "claude") chats = context.SherryClaudeImport.normalize([{
      uuid: "chat", name: "Invented", chat_messages: [
        { uuid: "prompt", sender: "human", created_at: "2026-10-30T10:00:00Z", content: [{ type: "text", text: "  code:\n    x = 1\npassword: invented-only-secret" }] },
        { uuid: "reply-a", sender: "assistant", content: [{ type: "text", text: "Repeated answer" }] },
        { uuid: "reply-b", sender: "assistant", content: [{ type: "text", text: "Repeated answer" }] }
      ]
    }]).conversations;
    else chats = context[provider === "chatgpt" ? "normalizeChatGptExport" : "normalizeGeminiExport"]([{
      id: "chat", title: "Invented", messages: [
        { id: "prompt", role: "user", timestamp: "2026-10-30T10:00:00Z", text: "  code:\n    x = 1\npassword: invented-only-secret" },
        { id: "reply-a", role: "assistant", text: "Repeated answer" },
        { id: "reply-b", role: "assistant", text: "Repeated answer" }
      ]
    }], "a".repeat(64));
    assert.equal(await context.uploadImportedConversation(provider, chats[0], "import:first"), 3);
    assert.equal(await context.uploadImportedConversation(provider, chats[0], "import:retry"), 3);
    assert.equal(stored.size, 3);
    assert.deepEqual(outcomes, [{ inserted: 3, duplicates: 0 }, { inserted: 0, duplicates: 3 }]);
    const first = stored.get("prompt");
    assert.equal(first.text, "  code:\n    x = 1\npassword: [REDACTED_CREDENTIAL]");
    assert.equal(first.messageTimestamp, "2026-10-30T10:00:00.000Z");
    assert.equal(first.role, "user");
    const events = [...stored.values()].map((event) => ({ provider_message_id: event.providerMessageId, text_content: event.text, role: event.role, sequence: event.sequence, message_timestamp: event.messageTimestamp }));
    assert.equal(context.SherryImportIntegrity.verifyReadback(chats[0].messages, events, { verificationVersion: 2, redactText }), 3);
    if (provider === "claude") {
      assert.equal(context.SherryClaudeImport.classifyMessage(chats[0].messages[0], events, redactText), "duplicate");
    }
  });
}

test("a foreign receipt stops a multi-batch import after the unconfirmed first request", async () => {
  let requests = 0;
  const context = harness(async () => {
    requests += 1;
    return { ok: true, batchId: "foreign", result: { status: "committed", received: 75, inserted: 75, updated: 0, duplicates: 0 } };
  });
  const messages = Array.from({ length: 76 }, (_, index) => ({ id: `message-${index}`, role: "user", text: "Invented", timestamp: null, attachments: [] }));
  await assert.rejects(context.uploadImportedConversation("chatgpt", { id: "chat", title: "Invented", sourceUrl: null, messages }, "import:test"), /confirm/);
  assert.equal(requests, 1);
});
