import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const source = app.slice(app.indexOf("function chatMessageCount("), app.indexOf("function activateChat("));
const context = {
  chatSort: "recent",
  conversationActivityAt: (item) => item.last_activity_at || item.last_captured_at
};
vm.runInNewContext(`${source}\nthis.sortConversations = sortConversations;`, context);

const chats = [
  { id: "late", title: "zeta", last_activity_at: "2026-10-04T00:00:00Z", conversation_events: [{ count: 3 }] },
  { id: "early", title: "Alpha", last_activity_at: "2026-09-01T00:00:00Z", conversation_events: [{ count: 12 }] },
  { id: "middle", title: "beta", last_activity_at: "2026-10-01T00:00:00Z", message_count: 5 }
];
const ids = (items) => Array.from(items, (item) => item.id);

test("chat sorting supports activity, title, and message count without changing source order", () => {
  assert.deepEqual(ids(context.sortConversations(chats, "recent")), ["late", "middle", "early"]);
  assert.deepEqual(ids(context.sortConversations(chats, "oldest")), ["early", "middle", "late"]);
  assert.deepEqual(ids(context.sortConversations(chats, "title-asc")), ["early", "middle", "late"]);
  assert.deepEqual(ids(context.sortConversations(chats, "title-desc")), ["late", "middle", "early"]);
  assert.deepEqual(ids(context.sortConversations(chats, "most-messages")), ["early", "middle", "late"]);
  assert.deepEqual(ids(chats), ["late", "early", "middle"]);
});

test("missing activity and repeated titles sort predictably", () => {
  const items = [
    { id: "b", title: "Same", message_count: 0 },
    { id: "a", title: "Same", message_count: 0 },
    { id: "new", title: "New", last_captured_at: "2026-10-05T00:00:00Z", message_count: 1 }
  ];
  assert.deepEqual(ids(context.sortConversations(items, "recent")), ["new", "a", "b"]);
  assert.deepEqual(ids(context.sortConversations(items, "oldest")), ["a", "b", "new"]);
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
    if (selector !== "tbody") throw new Error(`Unexpected selector ${selector}`);
    return this.body ||= new FakeElement("tbody");
  }
}

test("table view gives each chat an accessible open or select button", () => {
  const selectedChatIds = new Set(["late"]);
  const opened = [];
  const tableContext = {
    document: { createElement: (tag) => new FakeElement(tag) },
    selectedChatIds,
    selectingChats: true,
    activateChat: (chat) => opened.push(chat.id),
    summaryForConversation: () => ({ summary_text: "A saved chat summary" }),
    truncateText: (value) => value,
    providerLabel: (provider) => provider.toUpperCase(),
    formatDateTime: (value) => value,
    conversationActivityAt: (item) => item.last_activity_at,
    conversationActivityLabel: () => "Last message"
  };
  vm.runInNewContext(`${source}\n${app.slice(app.indexOf("function renderChatTable("), app.indexOf("function render()"))}\nthis.renderChatTable = renderChatTable;`, tableContext);
  const table = tableContext.renderChatTable([{ ...chats[0], provider: "chatgpt" }]);
  assert.equal(table.tagName, "table");
  assert.match(table.innerHTML, /<th scope="col">Last activity<\/th>/);
  const row = table.body.children[0];
  assert.equal(row.children.length, 4);
  const button = row.children[0].children[0];
  assert.equal(button.attributes["aria-pressed"], "true");
  assert.equal(button.attributes["aria-label"], "Deselect zeta");
  assert.equal(button.children[0].textContent, "zeta");
  button.onclick();
  assert.deepEqual(opened, ["late"]);
});
