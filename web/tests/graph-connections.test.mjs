import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../graph-connections.js", import.meta.url), "utf8");
const context = {};
context.globalThis = context;
vm.runInNewContext(source, context);
const { build } = context.SherryGraphConnections;

test("connects chats with a distinctive shared project title without invented fallback links", () => {
  const links = build([
    { id: "a", title: "Crossville context summary", provider: "claude" },
    { id: "b", title: "Crossville prototype ideas", provider: "chatgpt" },
    { id: "c", title: "Pasta dinner recipes", provider: "claude" }
  ]);
  assert.equal(links.length, 1);
  assert.deepEqual([links[0].sourceId, links[0].targetId], ["a", "b"]);
  assert.match(links[0].relationship, /Crossville|crossville/);
});

test("matches normalized summary topics even when their word order differs", () => {
  const links = build([
    { id: "a", title: "Project kickoff" },
    { id: "b", title: "Launch workshop" }
  ], [
    { conversation_id: "a", topics: ["Product roadmap"] },
    { conversation_id: "b", topics: ["Roadmap product"] }
  ]);
  assert.equal(links.length, 1);
  assert.match(links[0].relationship, /summaries/);
  assert.match(links[0].relationship, /Product roadmap/);
});

test("uses each chat's latest summary rather than an older version", () => {
  const links = build([
    { id: "a", title: "First meeting" },
    { id: "b", title: "Second meeting" }
  ], [
    { conversation_id: "a", topics: ["Crossville prototype"] },
    { conversation_id: "a", topics: ["Old research plan"] },
    { conversation_id: "b", topics: ["Crossville prototype"] }
  ]);
  assert.equal(links.length, 1);
  assert.match(links[0].relationship, /Crossville prototype/);
});

test("uses source-backed memory claims and does not connect only by provider or generic AI words", () => {
  const conversations = [
    { id: "a", title: "Design decisions", provider: "claude" },
    { id: "b", title: "Design review", provider: "gemini" },
    { id: "c", title: "AI chat conversation", provider: "claude" }
  ];
  const links = build(conversations, [], [
    { conversation_id: "a", status: "confirmed", display_text: "User prefers concise slide writing" },
    { conversation_id: "b", status: "provisional", display_text: "User prefers concise slide writing" }
  ]);
  assert.equal(links.length, 1);
  assert.deepEqual([links[0].sourceId, links[0].targetId], ["a", "b"]);
});

test("limits links per chat so the canvas does not become a hairball", () => {
  const conversations = Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, title: `Crossville workstream ${index}` }));
  const links = build(conversations, [], [], 2);
  const degrees = new Map();
  for (const link of links) {
    degrees.set(link.sourceId, (degrees.get(link.sourceId) || 0) + 1);
    degrees.set(link.targetId, (degrees.get(link.targetId) || 0) + 1);
  }
  assert.ok([...degrees.values()].every((degree) => degree <= 2));
});
