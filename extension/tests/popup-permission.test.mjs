import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/popup.js", import.meta.url), "utf8");

test("Reconnect requests Sherry permission synchronously from the click handler", async () => {
  const nodes = new Map();
  const calls = [];
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
      query: async () => [{ id: 7, url: "https://shared-memory-ingestion.mufaddal-m25.workers.dev/#diagnostics" }]
    },
    permissions: {
      request(request) { calls.push(["request", request.origins[0]]); return Promise.resolve(true); }
    },
    scripting: {
      executeScript(options) { calls.push(["inject", options.target.tabId]); return Promise.resolve(); }
    }
  };
  vm.runInNewContext(source, { document, browser, globalThis: { browser }, Intl, Date, setTimeout });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  const button = nodes.get("#connect-sherry");
  assert.equal(button.disabled, false);
  button.listeners.click();
  assert.equal(calls[0][0], "request");
  assert.equal(calls[0][1], "https://shared-memory-ingestion.mufaddal-m25.workers.dev/*");
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.deepEqual(calls.at(-1), ["inject", 7]);
});
