import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/chatgpt-adapter.js", import.meta.url), "utf8");
const start = source.indexOf("function uniqueTopLevelTurns(elements)");
const end = source.indexOf("function extractLinks(turn)", start);
assert.ok(start >= 0 && end > start);
const context = {};
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.helpers = { expandTurn, detectRole, getProviderMessageId };`, context);
const { expandTurn, detectRole, getProviderMessageId } = context.helpers;

function messageBlock(role, group) {
  return {
    innerText: role === "user" ? "You said:\nHello" : "ChatGPT said:\nHello back",
    matches: () => false,
    querySelector: () => null,
    getAttribute: () => null,
    closest: () => group
  };
}

test("splits the current ChatGPT exchange wrapper into separate user and assistant events", () => {
  const group = {
    matches: (selector) => selector === "[data-turn-key]",
    getAttribute: (name) => name === "data-turn-key" ? "turn-123" : null
  };
  const user = messageBlock("user", group);
  const assistant = messageBlock("assistant", group);
  group.querySelectorAll = () => [
    { textContent: "You said:", parentElement: user },
    { textContent: "ChatGPT said:", parentElement: assistant }
  ];

  assert.deepEqual(Array.from(expandTurn(group)), [user, assistant]);
  assert.equal(detectRole(user), "user");
  assert.equal(detectRole(assistant), "assistant");
  assert.equal(getProviderMessageId(user), "turn-123:user");
  assert.equal(getProviderMessageId(assistant), "turn-123:assistant");
});

test("keeps the previous one-message-per-turn layout working", () => {
  const turn = { matches: () => false };
  assert.deepEqual(Array.from(expandTurn(turn)), [turn]);
});
