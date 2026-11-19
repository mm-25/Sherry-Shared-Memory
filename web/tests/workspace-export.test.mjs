import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const start = source.indexOf("async function prepareExport() {");
const end = source.indexOf("function bootPreview()", start);
assert.ok(start >= 0 && end > start);
const prepareSource = source.slice(start, end);

function exportContext(api) {
  const context = {
    isPreview: false,
    conversations: [{ id: "chat-1" }],
    workspace: { id: "workspace-1", name: "Test space" },
    api,
    console: { warn() {} },
    exportPayload: null
  };
  vm.runInNewContext(`${prepareSource}\nglobalThis.runExport = prepareExport;`, context);
  return context;
}

test("workspace export includes chats, summaries, and Personal Memory notes", async () => {
  const paths = [];
  const context = exportContext(async (path) => {
    paths.push(path);
    if (path.startsWith("/v1/conversations/")) return { conversation: { id: "chat-1", events: [{ text_content: "test" }] } };
    if (path.startsWith("/v1/summaries")) return { summaries: [{ id: "summary-1" }] };
    if (path.startsWith("/v1/personal-memory")) return { entries: [{ id: "note-1" }], categories: [{ id: "category-1" }] };
    throw new Error("Unexpected export request");
  });
  await context.runExport();
  const payload = JSON.parse(JSON.stringify(context.exportPayload));
  assert.equal(payload.conversations[0].events[0].text_content, "test");
  assert.equal(payload.summaries[0].id, "summary-1");
  assert.equal(payload.personalMemory.entries[0].id, "note-1");
  assert.equal(payload.personalMemory.categories[0].id, "category-1");
  assert.equal(paths.length, 3);
});

test("workspace export does not offer an incomplete download when one section fails", async () => {
  const context = exportContext(async (path) => {
    if (path.startsWith("/v1/conversations/")) return { conversation: { id: "chat-1" } };
    if (path.startsWith("/v1/summaries")) return { summaries: [] };
    throw new Error("Personal Memory unavailable");
  });
  await context.runExport();
  assert.equal(context.exportPayload, null);
});

test("workspace export reads a large chat list in bounded groups", async () => {
  let active = 0;
  let peak = 0;
  const context = exportContext(async (path) => {
    if (path.startsWith("/v1/conversations/")) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { conversation: { id: path.split("/")[3].split("?")[0] } };
    }
    if (path.startsWith("/v1/summaries")) return { summaries: [] };
    if (path.startsWith("/v1/personal-memory")) return { entries: [], categories: [] };
    throw new Error("Unexpected export request");
  });
  context.conversations = Array.from({ length: 14 }, (_, index) => ({ id: `chat-${index}` }));
  await context.runExport();
  assert.equal(context.exportPayload.conversations.length, 14);
  assert.ok(peak <= 6);
});
