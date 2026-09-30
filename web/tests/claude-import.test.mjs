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
  const exact = [{ provider_message_id: "message-1", role: "user", text_content: "Please review the design." }];
  assert.equal(importer.classifyMessage(message, exact), "duplicate");
  assert.equal(importer.classifyMessage(message, [{ ...exact[0], text_content: "Different text" }]), "ambiguous");
  assert.equal(importer.classifyMessage(message, [{ provider_message_id: null, role: "user", text_content: "Please review the design.", message_timestamp: "2026-09-24T10:00:00Z" }]), "duplicate");
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
