import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const sortSource = app.slice(app.indexOf("function chatMessageCount("), app.indexOf("function newChatExpiryAt("));
const sortContext = { chatSort: "recent", conversationActivityAt: (item) => item.last_activity_at || item.last_captured_at };
vm.runInNewContext(`${sortSource}\nthis.sortConversations = sortConversations;`, sortContext);

const chats = [
  { id: "late", title: "zeta", last_activity_at: "2026-10-04T00:00:00Z", conversation_events: [{ count: 3 }] },
  { id: "early", title: "Alpha", last_activity_at: "2026-09-01T00:00:00Z", conversation_events: [{ count: 12 }] },
  { id: "middle", title: "beta", last_activity_at: "2026-10-01T00:00:00Z", message_count: 5 }
];
const ids = (items) => Array.from(items, (item) => item.id);

test("chat sorting supports activity, title, and message count without changing source order", () => {
  assert.deepEqual(ids(sortContext.sortConversations(chats, "recent")), ["late", "middle", "early"]);
  assert.deepEqual(ids(sortContext.sortConversations(chats, "oldest")), ["early", "middle", "late"]);
  assert.deepEqual(ids(sortContext.sortConversations(chats, "title-asc")), ["early", "middle", "late"]);
  assert.deepEqual(ids(sortContext.sortConversations(chats, "title-desc")), ["late", "middle", "early"]);
  assert.deepEqual(ids(sortContext.sortConversations(chats, "most-messages")), ["early", "middle", "late"]);
  assert.deepEqual(ids(chats), ["late", "early", "middle"]);
});

test("missing activity and repeated titles sort predictably", () => {
  const items = [
    { id: "b", title: "Same", message_count: 0 },
    { id: "a", title: "Same", message_count: 0 },
    { id: "new", title: "New", last_captured_at: "2026-10-05T00:00:00Z", message_count: 1 }
  ];
  assert.deepEqual(ids(sortContext.sortConversations(items, "recent")), ["new", "a", "b"]);
  assert.deepEqual(ids(sortContext.sortConversations(items, "oldest")), ["a", "b", "new"]);
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.classes = new Set();
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector(selector) {
    if (selector === "tbody") return this.body ||= new FakeElement("tbody");
    if (selector === "thead th") return this.header ||= new FakeElement("th");
    throw new Error(`Unexpected selector ${selector}`);
  }
  focus() { this.focused = true; }
}

function harness(items) {
  const storage = new Map();
  const selectedChatIds = new Set();
  let renders = 0;
  const context = {
    NEW_CHAT_WINDOW_MS: 5 * 60 * 1000,
    workspace: { id: "workspace-1" },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    conversations: items,
    selectedChatIds,
    deletingChats: false,
    newChatExpiryTimer: null,
    seenNewChatStorageKey: null,
    seenNewChatExpiries: {},
    document: { createElement: (tag) => new FakeElement(tag), querySelectorAll: () => [] },
    $: () => ({ querySelector: () => new FakeElement("input") }),
    render: () => { renders += 1; },
    clearTimeout: () => {},
    setTimeout: () => 1,
    summaryForConversation: () => ({ summary_text: "A saved chat summary" }),
    truncateText: (value) => value,
    providerLabel: (provider) => provider.toUpperCase(),
    formatDateTime: (value) => value,
    conversationActivityAt: (item) => item.last_activity_at,
    conversationActivityLabel: () => "Last message",
    chatMessageCount: (item) => item.conversation_events?.[0]?.count || item.message_count || 0,
    openConversation: (id) => { context.opened = id; }
  };
  const source = app.slice(app.indexOf("function newChatExpiryAt("), app.indexOf("function render()"));
  vm.runInNewContext(`${source}\nthis.isNewChat = isNewChat; this.markChatSeen = markChatSeen; this.renderChatTable = renderChatTable;`, context);
  return { context, storage, selectedChatIds, renders: () => renders };
}

test("New appears for five minutes from platform addition and stays hidden after opening", () => {
  const now = Date.now();
  const chat = { id: "recent", title: "Recent chat", created_at: new Date(now - 2 * 60_000).toISOString() };
  const { context, storage } = harness([chat]);
  assert.equal(context.isNewChat(chat, now), true);
  assert.equal(context.isNewChat(chat, now + 3 * 60_000), false);
  assert.equal(context.isNewChat({ ...chat, created_at: undefined }, now), false);
  assert.equal(context.markChatSeen(chat.id), true);
  assert.equal(context.isNewChat(chat, now), false);
  assert.match(storage.get("sherry_seen_new_chats:workspace-1"), /recent/);
});

test("table view has a checkbox column, select-all, and a separate open action", () => {
  const now = Date.now();
  const chat = { ...chats[0], provider: "chatgpt", created_at: new Date(now - 60_000).toISOString() };
  const { context, selectedChatIds, renders } = harness([chat]);
  const table = context.renderChatTable([chat]);
  assert.equal(table.tagName, "table");
  assert.match(table.innerHTML, /<th scope="col" class="select-column"><\/th>/);
  assert.equal(table.header.children[0].attributes["aria-label"], "Select all visible chats");
  const row = table.body.children[0];
  assert.equal(row.children.length, 5);
  const checkbox = row.children[0].children[0];
  const button = row.children[1].children[0];
  assert.equal(checkbox.attributes["aria-label"], "Select zeta");
  assert.equal(button.children[0].children[1].textContent, "New");
  checkbox.checked = true;
  checkbox.onchange();
  assert.deepEqual([...selectedChatIds], ["late"]);
  assert.equal(renders(), 1);
  button.onclick();
  assert.equal(context.opened, "late");
});
