import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const refreshSource = app.slice(app.indexOf("async function refreshChatMemory()"), app.indexOf("function closeProviderMenu()"));

function makeHarness({ api, preview = false } = {}) {
  const classes = new Set();
  const label = { textContent: "Refresh" };
  const button = { disabled: false, querySelector: () => label };
  const status = {
    textContent: "",
    classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value)
    }
  };
  const requests = [];
  let renders = 0;
  const context = {
    $: (id) => id === "refreshChatMemory" ? button : status,
    isPreview: preview,
    workspace: { id: "test-workspace" },
    api: async (path, options) => {
      requests.push({ path, options });
      return api(path);
    },
    render: () => { renders += 1; }
  };
  vm.runInNewContext(`
    let refreshingChatMemory = false;
    let conversations = [{ id: "old-chat" }];
    let summaries = [{ id: "old-summary" }];
    let conversationFilters = { query: "draft", provider: "claude" };
    ${refreshSource}
    this.invoke = refreshChatMemory;
    this.snapshot = () => ({ conversations, summaries, conversationFilters });
  `, context);
  return { context, button, label, status, classes, requests, get renders() { return renders; } };
}

test("Chat Memory has a refresh control beside its heading", () => {
  assert.match(html, /<h2>Chat Memory<\/h2>[\s\S]*?id="refreshChatMemory"/);
  assert.match(html, /id="chatMemoryRefreshStatus"[^>]*role="status"/);
  assert.match(app, /\$\("refreshChatMemory"\)\.onclick=refreshChatMemory/);
});

test("refresh loads current chats and summaries without clearing filters", async () => {
  const harness = makeHarness({ api: async (path) => path.includes("/summaries")
    ? { summaries: [{ id: "new-summary" }] }
    : { conversations: [{ id: "new-chat" }] } });
  await harness.context.invoke();
  const state = harness.context.snapshot();
  assert.equal(state.conversations[0].id, "new-chat");
  assert.equal(state.summaries[0].id, "new-summary");
  assert.equal(state.conversationFilters.query, "draft");
  assert.equal(harness.renders, 1);
  assert.equal(harness.requests.length, 2);
  assert.ok(harness.requests.every(({ options }) => options.cache === "no-store"));
  assert.equal(harness.status.textContent, "Checked just now.");
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.label.textContent, "Refresh");
});

test("failed chat refresh leaves the previous list visible", async () => {
  const harness = makeHarness({ api: async (path) => {
    if (path.includes("/conversations")) throw new Error("Service unavailable");
    return { summaries: [{ id: "new-summary" }] };
  } });
  await harness.context.invoke();
  const state = harness.context.snapshot();
  assert.equal(state.conversations[0].id, "old-chat");
  assert.equal(state.summaries[0].id, "old-summary");
  assert.equal(harness.renders, 0);
  assert.match(harness.status.textContent, /Could not refresh chats: Service unavailable/);
  assert.ok(harness.classes.has("error"));
  assert.equal(harness.button.disabled, false);
});

test("a summary failure does not block fresh chats", async () => {
  const harness = makeHarness({ api: async (path) => {
    if (path.includes("/summaries")) throw new Error("Summary unavailable");
    return { conversations: [{ id: "new-chat" }] };
  } });
  await harness.context.invoke();
  const state = harness.context.snapshot();
  assert.equal(state.conversations[0].id, "new-chat");
  assert.equal(state.summaries[0].id, "old-summary");
  assert.equal(harness.renders, 1);
  assert.match(harness.status.textContent, /summaries could not refresh/);
});

test("sample preview does not claim a live refresh", async () => {
  const harness = makeHarness({ preview: true, api: async () => { throw new Error("Preview should not call the API"); } });
  await harness.context.invoke();
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.renders, 0);
  assert.equal(harness.status.textContent, "Sample data cannot refresh.");
  assert.equal(harness.button.disabled, false);
});
