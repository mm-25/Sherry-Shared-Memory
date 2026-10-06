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
