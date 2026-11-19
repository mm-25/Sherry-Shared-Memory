import test from "node:test";
import assert from "node:assert/strict";
import { restoreOpenTabs, restoreTab, scriptsForOpenTab } from "../src/tab-recovery.js";

test("existing provider tabs get their automatic capture adapters after add-on startup", async () => {
  const injected = [];
  const api = {
    tabs: { query: async () => [
      { id: 1, url: "https://chatgpt.com/c/one" },
      { id: 2, url: "https://claude.ai/chat/two" },
      { id: 3, url: "https://gemini.google.com/app/three" },
      { id: 4, url: "https://shared-memory-ingestion.mufaddal-m25.workers.dev/" },
      { id: 5, url: "https://example.com/" }
    ] },
    scripting: { executeScript: async ({ target, files }) => {
      injected.push({ tabId: target.tabId, files });
      if (target.tabId === 2) throw new Error("tab closed");
    } }
  };
  assert.deepEqual(await restoreOpenTabs(api), { restored: 3, failed: 1 });
  assert.deepEqual(injected.map(({ tabId }) => tabId), [1, 2, 3, 4]);
  assert.deepEqual(injected.find(({ tabId }) => tabId === 3).files, [
    "/src/core.js", "/src/web-provider-adapter.js", "/src/gemini-adapter.js"
  ]);
});

test("tab recovery resumes an existing adapter without installing duplicate observers", async () => {
  const messages = [];
  let injections = 0;
  const api = {
    tabs: { sendMessage: async (_id, message) => { messages.push(message.type); return { ok: true }; } },
    scripting: { executeScript: async () => { injections++; } }
  };
  assert.equal(await restoreTab(api, { id: 1, url: "https://gemini.google.com/app/one" }), true);
  assert.deepEqual(messages, ["GET_CAPTURE_STATE", "RESUME_CAPTURE"]);
  assert.equal(injections, 0);
});

test("a missing adapter is installed from a normal tab event without activeTab or popup", async () => {
  let injections = 0;
  const api = {
    tabs: { sendMessage: async () => { throw new Error("Receiving end does not exist"); } },
    scripting: { executeScript: async () => { injections++; } }
  };
  assert.equal(await restoreTab(api, { id: 1, url: "https://gemini.google.com/app/one" }), true);
  assert.equal(await restoreTab(api, { id: 2, url: "https://example.com/" }), false);
  assert.equal(injections, 1);
});

test("tab recovery accepts only exact HTTPS provider hosts", () => {
  assert.equal(scriptsForOpenTab("https://gemini.google.com.evil.test/app"), null);
  assert.equal(scriptsForOpenTab("http://gemini.google.com/app"), null);
  assert.equal(scriptsForOpenTab("not-a-url"), null);
  assert.deepEqual(scriptsForOpenTab("https://chat.openai.com/c/one"), [
    "/src/core.js", "/src/chatgpt-adapter.js"
  ]);
});
