import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const start = source.indexOf("function importTimestamp(value) {");
const end = source.indexOf("function normalizeGeminiExport(data", start);
assert.ok(start >= 0 && end > start);
const context = { Date };
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.parseChatGptExport = normalizeChatGptExport;`, context);

test("ChatGPT export imports only the active conversation path in source order", () => {
  const parsed = context.parseChatGptExport([{
    id: "12345678-1234-1234-1234-123456789abc",
    title: "Invented test",
    current_node: "assistant-new",
    mapping: {
      root: { parent: null, message: { author: { role: "system" }, content: { parts: ["internal instruction"] } } },
      user: { parent: "root", message: { author: { role: "user" }, content: { parts: ["First question"] }, create_time: 1_700_000_000 } },
      "assistant-old": { parent: "user", message: { author: { role: "assistant" }, content: { parts: ["Discarded reply"] }, create_time: 1_700_000_001 } },
      "assistant-new": { parent: "user", message: { author: { role: "assistant" }, content: { parts: ["Current reply"] }, create_time: 1_700_000_002 } }
    }
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed[0].messages.map(({ id, role, text }) => ({ id, role, text })))), [
    { id: "user", role: "user", text: "First question" },
    { id: "assistant-new", role: "assistant", text: "Current reply" }
  ]);
  assert.equal(parsed[0].messages[0].timestamp, "2023-11-14T22:13:20.000Z");
  assert.equal(parsed.stats.sourceChats, 1);
  assert.equal(parsed.stats.alternateBranchNodes, 1);
});

test("ChatGPT export excludes hidden and tool messages", () => {
  const parsed = context.parseChatGptExport([{
    id: "test-chat",
    messages: [
      { id: "hidden", role: "user", content: { parts: ["hidden"] }, metadata: { is_visually_hidden_from_conversation: true } },
      { id: "tool", author: { role: "assistant" }, recipient: "python", content: { parts: ["tool call"] } },
      { id: "shown", author: { role: "assistant" }, content: { parts: ["Shown reply"] } }
    ]
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed[0].messages.map(({ id, text }) => ({ id, text })))), [
    { id: "shown", text: "Shown reply" }
  ]);
  assert.equal(parsed.stats.hiddenMessages, 1);
  assert.equal(parsed.stats.toolOrSystemMessages, 1);
});

test("ChatGPT import stops before upload when an active reply branch cannot be identified", () => {
  assert.throws(() => context.parseChatGptExport([{
    id: "branched-chat",
    mapping: {
      user: { parent: null, message: { author: { role: "user" }, content: { parts: ["Question"] } } },
      replyA: { parent: "user", message: { author: { role: "assistant" }, content: { parts: ["Reply A"] } } },
      replyB: { parent: "user", message: { author: { role: "assistant" }, content: { parts: ["Reply B"] } } }
    }
  }]), /no active branch marker/i);
});

test("ChatGPT import counts non-text content and rejects overlong text instead of silently shortening it", () => {
  const parsed = context.parseChatGptExport([{
    id: "mixed-chat",
    messages: [
      { id: "image", role: "user", content: { parts: [{ content_type: "image_asset_pointer" }] } },
      { id: "text", role: "assistant", content: { parts: ["Visible answer"] } }
    ]
  }]);
  assert.equal(parsed.stats.nonTextMessages, 1);
  assert.equal(parsed[0].messages.length, 1);
  assert.throws(() => context.parseChatGptExport([{
    id: "long-chat",
    messages: [{ id: "long", role: "user", content: { parts: ["x".repeat(240_001)] } }]
  }]), /not shortened silently/i);
});

test("ChatGPT preserves source array order, whitespace and the Unix epoch timestamp", () => {
  const parsed = context.parseChatGptExport([{ id: "chat", messages: [
    { id: "question", role: "user", text: "  code:\n    x = 1\n", create_time: 0 },
    { id: "answer", role: "assistant", text: "Answer", create_time: null }
  ] }]);
  assert.equal(parsed[0].messages[0].id, "question");
  assert.equal(parsed[0].messages[0].text, "  code:\n    x = 1\n");
  assert.equal(parsed[0].messages[0].timestamp, "1970-01-01T00:00:00.000Z");
  assert.equal(parsed[0].messages[1].id, "answer");
});

test("ChatGPT retains internal whitespace-only and empty recognized text parts", () => {
  const parsed = context.parseChatGptExport([{ id: "chat", messages: [
    { id: "multipart", role: "user", content: { parts: ["First", "\n\n", "  Last\n"] } },
    { id: "empty-part", role: "assistant", content: { parts: ["A", "", "B", { content_type: "image_asset_pointer" }] } },
    { id: "blank", role: "user", content: { parts: ["", " \n ", ""] } }
  ] }]);
  assert.equal(parsed[0].messages[0].text, "First\n\n\n\n  Last\n");
  assert.equal(parsed[0].messages[1].text, "A\n\nB");
  assert.equal(parsed[0].messages.length, 2);
  assert.equal(parsed.stats.nonTextMessages, 1);
});
