import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../transcript-order.js", import.meta.url), "utf8");
const context = {};
context.globalThis = context;
vm.runInNewContext(source, context);
const { messageTime, sort } = context.SherryTranscriptOrder;

test("uses message time when legacy positions repeat", () => {
  const events = [
    { id: "middle", sequence: 0, message_timestamp: "2026-09-27T09:00:00Z" },
    { id: "old", sequence: 0, first_captured_at: "2026-09-25T09:00:00Z" },
    { id: "new", sequence: 1, message_timestamp: "2026-09-28T09:00:00Z", first_captured_at: "2026-09-20T09:00:00Z" }
  ];
  assert.deepEqual(Array.from(sort(events), ({ id }) => id), ["new", "middle", "old"]);
  assert.deepEqual(Array.from(sort(events, "oldest"), ({ id }) => id), ["old", "middle", "new"]);
  assert.deepEqual(Array.from(events, ({ id }) => id), ["middle", "old", "new"]);
  assert.equal(messageTime(events[2]), events[2].message_timestamp);
});

test("keeps provider turn order when source and capture clocks disagree", () => {
  const events = [
    { id: "earlier-assistant", sequence: 1, role: "assistant", message_timestamp: "2026-09-28T19:12:45Z" },
    { id: "newer-assistant", sequence: 3, role: "assistant", message_timestamp: "2026-09-28T19:23:28Z" },
    { id: "newer-user", sequence: 2, role: "user", first_captured_at: "2026-09-28T19:23:31Z" }
  ];
  assert.deepEqual(Array.from(sort(events, "oldest"), ({ id }) => id), ["earlier-assistant", "newer-user", "newer-assistant"]);
  assert.deepEqual(Array.from(sort(events, "latest"), ({ id }) => id), ["newer-assistant", "newer-user", "earlier-assistant"]);
});

test("uses stored position for equal or unavailable timestamps", () => {
  const events = [
    { id: "first", captured_at: "2026-09-28T09:00:00Z" },
    { id: "second", captured_at: "2026-09-28T09:00:00Z" },
    { id: "undated" }
  ];
  assert.deepEqual(Array.from(sort(events, "latest"), ({ id }) => id), ["second", "first", "undated"]);
  assert.deepEqual(Array.from(sort(events, "oldest"), ({ id }) => id), ["first", "second", "undated"]);
});

test("loads transcript order before the app and removes the old explanatory line", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf("transcript-order.js") < html.indexOf("app.js?v="));
  assert.match(html, /<select id="transcriptSort"><option value="latest">Latest first<\/option><option value="oldest">Oldest first<\/option><\/select>/);
  assert.doesNotMatch(html, /id="transcriptOrder"/);
});

test('mobile backfill order is independent of observation time and dates remain explicitly unknown', () => {
  const events = [
    { id: 'later', sequence: 500000, captured_at: '2026-10-02T06:00:00Z', source_locator: 'android-session:test' },
    { id: 'earlier', sequence: 499999, captured_at: '2026-10-02T06:05:00Z', source_locator: 'android-session:test' }
  ];
  assert.deepEqual(Array.from(sort(events, 'oldest'), e => e.id), ['earlier', 'later']);
  assert.equal(context.SherryTranscriptOrder.observationLabel(events[0]), 'Original date unknown · observed');
  assert.equal(context.SherryTranscriptOrder.observationLabel({message_timestamp: '2020-01-01T00:00:00Z'}), 'Sent');
});
