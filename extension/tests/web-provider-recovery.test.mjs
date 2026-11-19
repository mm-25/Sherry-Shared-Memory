import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/web-provider-adapter.js", import.meta.url), "utf8");

test("Gemini adapter rescans missed page changes and reports the actual loaded count", async () => {
  class FakeTurn {
    constructor(index) { this.innerText = `Test message ${index}`; this.role = index % 2 ? "assistant" : "user"; }
    matches() { return true; }
    querySelectorAll() { return []; }
    contains(other) { return other === this; }
  }
  let turns = Array.from({ length: 4 }, (_, index) => new FakeTurn(index + 12));
  const intervals = [];
  const batches = [];
  let pageListener;
  const browser = {
    storage: { sync: { get: async (defaults) => defaults } },
    runtime: {
      onMessage: { addListener(listener) { pageListener = listener; } },
      sendMessage: async (message) => {
        if (message.type === "CAPTURE_BATCH") {
          batches.push(message.payload.events);
          return { ok: true, result: { added: message.payload.events.length, updated: 0 } };
        }
        return { ok: true };
      }
    }
  };
  const coreContext = { URL };
  vm.runInNewContext(await readFile(new URL("../src/core.js", import.meta.url), "utf8"), coreContext);
  const core = coreContext.SharedMemoryCaptureCore;
  const context = {
    globalThis: { browser, SharedMemoryCaptureCore: core },
    browser,
    Element: FakeTurn,
    location: { href: "https://gemini.google.com/app/test-conversation", origin: "https://gemini.google.com", pathname: "/app/test-conversation" },
    document: { title: "Test chat", body: {}, visibilityState: "visible", querySelectorAll: () => turns },
    MutationObserver: class { observe() {} disconnect() {} },
    performance: { now: () => 1 },
    setInterval: (callback) => intervals.push(callback),
    setTimeout: () => 1,
    clearTimeout: () => {},
    Date,
    URL
  };
  vm.runInNewContext(source, context);
  context.globalThis.SharedMemoryWebProviderAdapter.start({
    provider: "gemini",
    turnSelector: "user-query,model-response",
    detectRole: (turn) => turn.role,
    findMessageNode: (turn) => turn,
    getTitle: () => "Test chat"
  });
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  assert.equal(batches[0].length, 4);
  turns = Array.from({ length: 16 }, (_, index) => new FakeTurn(index));
  intervals[1]();
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  assert.equal(batches[1].length, 16);
  const state = await new Promise((resolve) => pageListener({ type: "GET_CAPTURE_STATE" }, {}, resolve));
  assert.equal(state.lastScanCandidates, 16);
  assert.equal(state.lastScanReadable, 16);
  const manual = await new Promise((resolve) => pageListener({ type: "CAPTURE_NOW" }, {}, resolve));
  assert.equal(manual.candidates, 16);
  assert.equal(manual.readable, 16);
  assert.equal(manual.stored, 0);

  turns[2].role = "unknown";
  const withUnreadableTurn = await new Promise((resolve) => pageListener({ type: "CAPTURE_NOW" }, {}, resolve));
  assert.equal(withUnreadableTurn.candidates, 16);
  assert.equal(withUnreadableTurn.readable, 15);
  assert.equal(withUnreadableTurn.stored, 0);
});
