import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/popup.js", import.meta.url), "utf8");

function popupOn(url, injectionError = null) {
  const nodes = new Map();
  const calls = [];
  let injected = false;
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, {
        disabled: false,
        hidden: false,
        textContent: "",
        listeners: {},
        addEventListener(type, listener) { this.listeners[type] = listener; }
      });
      return nodes.get(selector);
    }
  };
  const browser = {
    runtime: {
      getManifest: () => ({ version: "0.4.9" }),
      sendMessage: async () => ({ settings: {}, captureStats: {} })
    },
    tabs: {
      query: async () => [{ id: 17, url }],
      sendMessage: async (_id, message) => {
        calls.push(["message", message.type]);
        if (!injected) throw new Error("Could not establish connection. Receiving end does not exist.");
        return { ok: true, provider: new URL(url).hostname, conversationId: "test-chat" };
      }
    },
    scripting: {
      executeScript: async ({ target, files }) => {
        calls.push(["inject", target.tabId, [...files]]);
        if (injectionError) throw new Error(injectionError);
        injected = true;
      }
    }
  };
  vm.runInNewContext(source, { document, browser, globalThis: { browser }, Intl, Date, URL, setTimeout });
  return { nodes, calls };
}

async function settle() {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

for (const [url, files] of [
  ["https://chatgpt.com/c/test-chat", ["/src/core.js", "/src/chatgpt-adapter.js"]],
  ["https://claude.ai/chat/test-chat", ["/src/core.js", "/src/web-provider-adapter.js", "/src/claude-adapter.js"]],
  ["https://gemini.google.com/app/test-chat", ["/src/core.js", "/src/web-provider-adapter.js", "/src/gemini-adapter.js"]]
]) {
  test(`popup repairs a missing content script on ${new URL(url).hostname}`, async () => {
    const { nodes, calls } = popupOn(url);
    await settle();
    assert.deepEqual(calls, [
      ["message", "GET_CAPTURE_STATE"],
      ["inject", 17, files],
      ["message", "GET_CAPTURE_STATE"]
    ]);
    assert.match(nodes.get("#page-status").textContent, /Ready/);
    assert.equal(nodes.get("#error").hidden, true);
  });
}

test("popup explains when Zen denies adapter injection", async () => {
  const { nodes, calls } = popupOn("https://claude.ai/chat/test-chat", "Missing host permission");
  await settle();
  assert.equal(calls.filter(([kind]) => kind === "inject").length, 1);
  assert.match(nodes.get("#error").textContent, /Check site access in Zen/);
  assert.match(nodes.get("#error").textContent, /Missing host permission/);
});
