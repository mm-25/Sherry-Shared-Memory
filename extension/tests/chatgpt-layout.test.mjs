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

test("a ChatGPT local conversation label is never accepted as a permanent cloud identity", async () => {
  const core = await readFile(new URL("../src/core.js",import.meta.url),"utf8");
  const begin=source.indexOf("function getConversationRegionLabel()");
  const end=source.indexOf("function closestTurn(node)",begin);
  const page={URL,location:{href:"https://chatgpt.com/"},document:{title:"Invented chat",
    querySelector:(selector)=>selector==="[aria-label^='Conversation ']"?{getAttribute:()=>"Conversation local-chatgpt:invented-local-id"}:null}};
  const scope=vm.createContext(page);vm.runInContext(core,scope);
  vm.runInContext(`const core=SharedMemoryCaptureCore;const state={provisionalId:"pending:chatgpt:tab-test"};${source.slice(begin,end)};globalThis.meta=getConversationMeta;`,scope);
  assert.equal(scope.meta().conversationId,"pending:chatgpt:tab-test");
  page.location.href="https://chatgpt.com/c/permanent-chat-id";
  assert.equal(scope.meta().conversationId,"permanent-chat-id");
});
