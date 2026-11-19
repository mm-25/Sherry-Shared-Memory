import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/popup.js", import.meta.url), "utf8");

function runChromePopup(url) {
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
  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "0.4.9" }),
      sendMessage(_message, callback) { callback({ settings: {}, captureStats: {} }); }
    },
    tabs: {
      query: async () => [{ id: 23, url }],
      sendMessage(_id, message, callback) {
        calls.push(["message", message.type]);
        if (!injected) chrome.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
        callback(injected ? { ok: true, provider: "chatgpt", conversationId: "test" } : undefined);
        chrome.runtime.lastError = null;
      }
    },
    permissions: {
      getAll: async () => ({ origins: [new URL(url).origin + "/*"] }),
      request() { calls.push(["unexpected-permission-request"]); throw new Error("Required origin must not be requested"); }
    },
    scripting: {
      async executeScript({ files }) { calls.push(["inject", [...files]]); injected = true; return []; }
    }
  };
  vm.runInNewContext(source, { document, chrome, globalThis: { chrome }, Intl, Date, URL, setTimeout });
  return { nodes, calls };
}

async function settle() {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

test("Chromium popup waits for an explicit manual action before recovering a missing reader", async () => {
  const { nodes, calls } = runChromePopup("https://chatgpt.com/c/test");
  await settle();
  assert.deepEqual(calls, [["message", "GET_CAPTURE_STATE"]]);
  assert.match(nodes.get("#page-status").textContent, /has not started/);
  await nodes.get("#capture-now").listeners.click();
  assert.deepEqual(calls.find(([kind]) => kind === "inject"), ["inject", ["/src/core.js", "/src/chatgpt-adapter.js"]]);
});

test("Chromium reconnect uses its installed required Sherry permission", async () => {
  const { nodes, calls } = runChromePopup("https://shared-memory-ingestion.mufaddal-m25.workers.dev/#diagnostics");
  await settle();
  nodes.get("#connect-sherry").listeners.click();
  await settle();
  assert.deepEqual(calls, [["inject", ["/src/sherry-bridge.js"]]]);
});
