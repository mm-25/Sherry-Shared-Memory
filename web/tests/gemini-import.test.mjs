import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const start = source.indexOf("function importTimestamp(value) {");
const end = source.indexOf("function normalizeGeminiHtml(text", start);
const context = { Date };
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.parse = normalizeGeminiExport;`, context);

test("Gemini structured imports retain visible source roles, text, dates and order", () => {
  const parsed = context.parse([{ id: "gemini-chat", messages: [
    { id: "prompt", role: "user", text: "Question\n  code", timestamp: "2026-10-30T10:00:00Z" },
    { id: "hidden", role: "system", text: "Private instructions" },
    { id: "answer", role: "model", text: "Visible answer", timestamp: "2026-10-30T10:00:01Z" }
  ] }]);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed[0].messages.map(({id, role, text, timestamp}) => ({id, role, text, timestamp})))), [
    { id: "prompt", role: "user", text: "Question\n  code", timestamp: "2026-10-30T10:00:00.000Z" },
    { id: "answer", role: "assistant", text: "Visible answer", timestamp: "2026-10-30T10:00:01.000Z" }
  ]);
});

test("identityless Gemini activity uses file identity so changed files cannot overwrite earlier rows", () => {
  const row = { title: "Prompted invented question", time: "2026-10-30T10:00:00Z" };
  const first = context.parse([row], "a".repeat(64));
  const retry = context.parse([row], "a".repeat(64));
  const otherFile = context.parse([row], "b".repeat(64));
  assert.equal(first[0].id, retry[0].id);
  assert.equal(first[0].messages[0].role, "unknown");
  assert.notEqual(first[0].id, otherFile[0].id);
  assert.throws(() => context.parse([row]), /file identity/i);
});

test("Gemini preserves whitespace-only source parts within an otherwise visible message", () => {
  const parsed = context.parse([{ id: "chat", messages: [
    { id: "multipart", role: "user", content: { parts: ["First", "\n\n", "  Last\n"] } },
    { id: "blank", role: "assistant", content: { parts: ["", " \n ", ""] } }
  ] }]);
  assert.equal(parsed[0].messages.length, 1);
  assert.equal(parsed[0].messages[0].text, "First\n\n\n\n  Last\n");
});
