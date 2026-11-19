import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../claude-import.js", import.meta.url), "utf8");
const context = { URL };
context.globalThis = context;
vm.runInNewContext(source, context);
const importer = context.SherryClaudeImport;

test("Claude import keeps visible text and source IDs while excluding tool and thinking blocks", () => {
  const data = [{
    uuid: "conversation-1",
    name: "A chat",
    summary: "Claude's native summary",
    chat_messages: [{
      uuid: "message-1", sender: "assistant", created_at: "2026-09-24T10:00:00Z",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "tool_use", name: "lookup", message: "not a chat response" },
        { type: "text", text: "First paragraph." },
        { type: "text", text: "Second paragraph." }
      ],
      attachments: [{ file_name: "design.pdf", file_size: 12, file_type: "application/pdf" }],
      files: [{ file_name: "design.pdf", file_uuid: "file-1" }]
    }, {
      uuid: "message-2", sender: "assistant", content: [{ type: "tool_result", message: "hidden tool result" }]
    }]
  }];
  const result = importer.normalize(data);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].messages.length, 1);
  assert.equal(result.conversations[0].messages[0].text, "First paragraph.\n\nSecond paragraph.");
  assert.equal(result.conversations[0].messages[0].id, "message-1");
  assert.equal(result.conversations[0].messages[0].timestamp, "2026-09-24T10:00:00.000Z");
  assert.equal(result.conversations[0].messages[0].attachments.length, 1);
  assert.equal(result.stats.nonTextMessages, 1);
});

test("Claude overlap checks IDs first and holds changed or uncertain matches", () => {
  const message = { id: "message-1", role: "user", text: "Please review the design.", timestamp: "2026-09-24T10:00:00Z" };
  const exact = [{ provider_message_id: "message-1", role: "user", text_content: "Please review the design.", message_timestamp: message.timestamp }];
  assert.equal(importer.classifyMessage(message, exact), "duplicate");
  assert.equal(importer.classifyMessage(message, [{ ...exact[0], text_content: "Different text" }]), "ambiguous");
  assert.equal(importer.classifyMessage(message, [{ provider_message_id: null, role: "user", text_content: "Please review the design.", message_timestamp: "2026-09-24T10:00:00Z" }]), "ambiguous");
  assert.equal(importer.classifyMessage(message, [{ provider_message_id: null, role: "user", text_content: "Please review the design." }]), "ambiguous");
  assert.equal(importer.classifyMessage(message, []), "new");
});

test("Claude conversations match only within the Claude provider by source identity", () => {
  const record = { id: "conversation-1" };
  const rows = [
    { provider: "chatgpt", provider_conversation_id: "conversation-1" },
    { provider: "claude", provider_conversation_id: "conversation-1" }
  ];
  assert.equal(importer.matchConversation(record, rows).length, 1);
});

test("Claude import holds same-title conversations whose live capture has no source identity", () => {
  const record = { id: "conversation-1", title: "Research notes" };
  const live = [{ provider: "claude", title: "Research notes", provider_conversation_id: "pending:abc" }];
  assert.equal(importer.matchConversation(record, live).length, 0);
  assert.equal(importer.possibleUnidentifiedOverlap(record, live), true);
  assert.equal(importer.possibleUnidentifiedOverlap(record, [{ ...live[0], title: "Other topic" }]), false);
  const longText = "An especially long original question about a project design handoff, including what should remain private and which details should be shared with collaborators.";
  assert.equal(importer.possibleContentOverlap({ ...record, messages: [{ role: "user", text: longText }] },
    [{ role: "user", text_content: longText }]), true);
});

test("Claude import rejects oversized visible text without silently losing its tail", () => {
  assert.throws(() => importer.normalize([{ uuid: "long-chat", chat_messages: [
    { uuid: "long-message", sender: "human", content: [{ type: "text", text: "x".repeat(250_001) }] }
  ] }]), /not shortened silently/i);
});

test("Claude keeps source whitespace and holds differing same-ID text or date", () => {
  const parsed = importer.normalize([{ uuid: "chat", chat_messages: [
    { uuid: "message", sender: "human", created_at: "2026-10-30T10:00:00Z", content: [{ type: "text", text: "  Code:\n    x = 1\n" }] }
  ] }]);
  const message = parsed.conversations[0].messages[0];
  assert.equal(message.text, "  Code:\n    x = 1\n");
  const stored = { provider_message_id: "message", role: "user", text_content: message.text, message_timestamp: message.timestamp, sequence: 0 };
  assert.equal(importer.classifyMessage(message, [stored]), "duplicate");
  assert.equal(importer.classifyMessage(message, [{ ...stored, text_content: "Code: x = 1" }]), "ambiguous");
  assert.equal(importer.classifyMessage(message, [{ ...stored, message_timestamp: "2026-10-30T11:00:00Z" }]), "ambiguous");
});

test("Claude does not merge two proven distinct message IDs because their text and time match", () => {
  const message = { id: "new-turn", role: "user", text: "repeat", timestamp: "2026-10-30T10:00:00Z" };
  assert.equal(importer.classifyMessage(message, [{ provider_message_id: "old-turn", role: "user", text_content: "repeat", message_timestamp: message.timestamp }]), "new");
});

test("Claude retains whitespace-only text blocks inside visible messages and skips entirely blank messages", () => {
  const parsed = importer.normalize([{ uuid: "chat", chat_messages: [
    { uuid: "multipart", sender: "human", content: [
      { type: "text", text: "First" }, { type: "text", text: "\n\n" }, { type: "text", text: "  Last\n" }
    ] },
    { uuid: "blank", sender: "assistant", content: [{ type: "text", text: " \n " }, { type: "text", text: "" }] }
  ] }]);
  assert.equal(parsed.conversations[0].messages[0].text, "First\n\n\n\n\n\n  Last\n");
  assert.equal(parsed.conversations[0].messages.length, 1);
  assert.equal(parsed.stats.nonTextMessages, 1);
});

test("Claude excludes oversized unsupported sender records before validating visible message size", () => {
  for (const sender of ["tool", "system"]) {
    const parsed = importer.normalize([{ uuid: "chat", chat_messages: [
      { uuid: "excluded", sender, content: [{ type: "text", text: "x".repeat(240_001) }] },
      { uuid: "prompt", sender: "human", content: [{ type: "text", text: "Visible ordinary prompt" }] }
    ] }]);
    assert.equal(parsed.conversations[0].messages.length, 1);
    assert.equal(parsed.conversations[0].messages[0].text, "Visible ordinary prompt");
    assert.equal(parsed.stats.invalidIds, 1);
  }
});

test("Claude rejects whitespace-altered source UUIDs instead of silently changing identity", () => {
  const message = { uuid: "message", sender: "human", content: [{ type: "text", text: "Visible" }] };
  assert.throws(() => importer.normalize([{ uuid: " chat ", chat_messages: [message] }]), /identity/);
  assert.throws(() => importer.normalize([{ uuid: "chat", chat_messages: [{ ...message, uuid: " message " }] }]), /identity/);
});
