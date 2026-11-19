import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const activity = source.slice(source.indexOf("function conversationActivityAt("), source.indexOf("function conversationActivityLabel("));
const sorting = source.slice(source.indexOf("function chatMessageCount("), source.indexOf("function newChatExpiryAt("));
const context = {};
vm.runInNewContext(`let chatSort = "recent"; ${activity} ${sorting}; this.sortChats = sortConversations;`, context);

test("recent orders message/capture activity rather than the date a backlog arrives", () => {
  const rows = [
    { id: "old-phone-uploaded-today", title: "A", primary_surface: "android", created_at: "2026-10-28T20:00:00Z", last_activity_at: "2026-10-25T10:00:00Z" },
    { id: "new-phone", title: "B", primary_surface: "android", last_activity_at: "2026-10-28T19:00:00Z" },
    { id: "newer-desktop", title: "C", primary_surface: "desktop", last_activity_at: "2026-10-28T20:00:00Z" }
  ];
  assert.deepEqual(Array.from(context.sortChats(rows), ({ id }) => id), ["newer-desktop", "new-phone", "old-phone-uploaded-today"]);
  assert.equal(rows[0].id, "old-phone-uploaded-today");
});
test("recent uses capture time when original activity is unavailable", () => {
  const rows = [{ id: "a", last_captured_at: "2026-10-25T10:00:00Z" }, { id: "b", last_captured_at: "2026-10-28T10:00:00Z" }];
  assert.deepEqual(Array.from(context.sortChats(rows), ({ id }) => id), ["b", "a"]);
});
