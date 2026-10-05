import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const source = app.slice(app.indexOf("function openBulkDeleteDialog("), app.indexOf("function closeProviderMenu()"));

function harness(api) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      textContent: "", value: "", disabled: false,
      classList: { toggle() {} }, showModal() {}, close() {}
    });
    return elements.get(id);
  };
  const context = {
    $: element,
    api,
    isPreview: false,
    workspace: { id: "workspace-1" },
    render() {},
    dashboardFallbackFromConversations: (items) => ({ count: items.length })
  };
  vm.runInNewContext(`
    let conversations = [{id:"chat-1"},{id:"chat-2"},{id:"chat-3"}];
    let summaries = [{id:"summary-1",conversation_id:"chat-1"},{id:"summary-2",conversation_id:"chat-2"}];
    let dashboardData = null;
    let selected = null;
    let selectedSummary = null;
    let deletingChats = false;
    let bulkDeleteTarget = null;
    const selectedChatIds = new Set(["chat-1","chat-2"]);
    ${source}
    this.open = openBulkDeleteDialog;
    this.delete = deleteChatBatch;
    this.snapshot = () => ({conversations, summaries, deletingChats, dashboardData, selected: [...selectedChatIds]});
  `, context);
  return { context, element };
}

test("bulk controls are separate from account deletion and require a phrase for all chats", () => {
  assert.match(html, /id="settingsDeleteChats"[^>]*>Delete all chats/);
  assert.match(html, /id="settingsDelete"[^>]*>/);
  const { context, element } = harness(async () => { throw new Error("Should not call API"); });
  context.open(["chat-1", "chat-2"], true);
  assert.equal(element("confirmBulkDelete").disabled, true);
  assert.match(element("bulkDeleteDescription").textContent, /all 2 chats/);
  context.open(["chat-1"], false);
  assert.equal(element("confirmBulkDelete").disabled, false);
});

test("bulk delete keeps failed chats selectable and refreshes the authoritative list", async () => {
  const requests = [];
  const { context, element } = harness(async (path, options) => {
    requests.push({ path, method: options?.method });
    if (options?.method === "DELETE" && path.includes("chat-2")) throw new Error("Temporary failure");
    if (options?.method === "DELETE") return { deleted: { cleanupPending: false } };
    if (path.startsWith("/v1/conversations?")) return { conversations: [{ id: "chat-2" }, { id: "chat-3" }] };
    if (path.startsWith("/v1/summaries?")) return { summaries: [{ id: "summary-2", conversation_id: "chat-2" }] };
    if (path.startsWith("/v1/dashboard?")) return { count: 2 };
    throw new Error("Unexpected request");
  });
  context.open(["chat-1", "chat-2"], false);
  await context.delete();
  const state = context.snapshot();
  assert.deepEqual(state.conversations.map((item) => item.id), ["chat-2", "chat-3"]);
  assert.deepEqual(state.summaries.map((item) => item.id), ["summary-2"]);
  assert.deepEqual(Array.from(state.selected), ["chat-2"]);
  assert.equal(state.deletingChats, false);
  assert.match(element("chatBulkStatus").textContent, /1 of 2 chats deleted/);
  assert.deepEqual(requests.filter((item) => item.method === "DELETE").map((item) => item.path.includes("chat-1") ? "chat-1" : "chat-2"), ["chat-1", "chat-2"]);
});
