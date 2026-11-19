import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/popup.js", import.meta.url), "utf8");

function popupOn(url, injectionError = null, options = {}) {
  const nodes = new Map();
  const calls = [];
  let injected = Boolean(options.page);
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
      getManifest: () => ({ version: "0.4.15" }),
      sendMessage: async (message) => {
        if (message.type === "GET_STATUS") return options.status || { settings: {}, captureStats: {} };
        if (message.type === "COUNT_CONVERSATION_CAPTURES") return { ok: true, count: options.localCount ?? 0 };
        if (message.type === "REUPLOAD_CONVERSATION") {
          if (options.repairError) return { ok: false, error: options.repairError };
          calls.push(["reupload", message.payload.provider, message.payload.conversationId]);
          return { ok: true, ingestion: { queuedEvents: options.localCount ?? 0 } };
        }
        return { ok: true };
      }
    },
    tabs: {
      query: async () => [{ id: 17, url }],
      sendMessage: async (_id, message) => {
        calls.push(["message", message.type]);
        if (!injected) throw new Error("Could not establish connection. Receiving end does not exist.");
        return options.page || { ok: true, provider: new URL(url).hostname, conversationId: "test-chat" };
      }
    },
    permissions: {
      getAll: async () => ({ origins: options.origins ?? [new URL(url).origin + "/*"] }),
      request: (request) => { calls.push(["permission", request.origins[0]]); return Promise.resolve(options.grant !== false); }
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
  test(`popup reports a missing reader without starting it on ${new URL(url).hostname}`, async () => {
    const { nodes, calls } = popupOn(url);
    await settle();
    assert.deepEqual(calls, [["message", "GET_CAPTURE_STATE"]]);
    assert.match(nodes.get("#page-status").textContent, /has not started/);
    assert.equal(nodes.get("#error").hidden, false);
    await nodes.get("#capture-now").listeners.click();
    assert.deepEqual(calls.find(([type]) => type === "inject"), ["inject", 17, files]);
  });
}

test("popup explains when Zen denies adapter injection", async () => {
  const { nodes, calls } = popupOn("https://claude.ai/chat/test-chat", "Missing host permission");
  await settle();
  await nodes.get("#capture-now").listeners.click();
  assert.equal(calls.filter(([kind]) => kind === "inject").length, 1);
  assert.match(nodes.get("#error").textContent, /Check site access in Zen/);
  assert.match(nodes.get("#error").textContent, /Missing host permission/);
});

test("popup prioritizes the current chat recovery without claiming cloud completeness", async () => {
  const { nodes, calls } = popupOn("https://gemini.google.com/app/test-chat", null, {
    status: {
      settings: { captureEnabled: true },
      captureStats: { totalEvents: 68, lastCaptureAt: "2026-10-01T14:12:00Z" },
      ingestion: { enabled: true, hasAccessToken: true, pendingBatches: 0, quarantinedBatches: 7, lastSyncAt: "2026-10-01T14:12:00Z" }
    },
    localCount: 38,
    page: { ok: true, provider: "gemini", conversationId: "test-chat", lastScanCandidates: 62, lastScanReadable: 38, lastScanStored: 0 }
  });
  await settle();
  assert.equal(nodes.get("#attention-panel").hidden, false);
  assert.match(nodes.get("#sync-alert").textContent, /7 earlier uploads failed/);
  assert.match(nodes.get("#scan-status").textContent, /62 message areas found · 38 readable messages/);
  assert.match(nodes.get("#repair-count").textContent, /38 saved on this device for this chat/);
  assert.equal(nodes.get("#repair-chat").hidden, false);
  assert.equal(nodes.get("#repair-chat").disabled, false);
  assert.doesNotMatch(nodes.get("#page-status").textContent, /test-chat/);
  assert.doesNotMatch(nodes.get("#sync-status").textContent, /cloud synced/i);
  await nodes.get("#repair-chat").listeners.click();
  assert.equal(calls.some(([kind, provider, conversationId]) => kind === "reupload" && provider === "gemini" && conversationId === "test-chat"), true);
  assert.match(nodes.get("#repair-status").textContent, /38 saved messages queued/);
});


test("temporary activeTab success does not masquerade as ongoing site permission", async () => {
  const { nodes, calls } = popupOn("https://gemini.google.com/app/test", null, {
    origins: [],
    page: { ok: true, provider: "gemini", conversationId: "test", lastScanAt: "2026-10-02T00:00:00Z" }
  });
  await settle();
  assert.equal(nodes.get("#site-access-panel").hidden, false);
  assert.match(nodes.get("#page-status").textContent, /needs site access/);
  assert.equal(calls.some(([kind]) => kind === "inject"), false);
  nodes.get("#grant-site-access").listeners.click();
  assert.deepEqual(calls.at(-1), ["permission", "https://gemini.google.com/*"]);
  await settle();
});

test("the first scan must finish before the popup reports that it is reading a conversation", async () => {
  const { nodes } = popupOn("https://gemini.google.com/app/test", null, {
    page: { ok: true, provider: "gemini", conversationId: null, lastScanAt: null }
  });
  await settle();
  assert.equal(nodes.get("#page-status").textContent, "Starting the first page scan…");
  assert.doesNotMatch(nodes.get("#page-status").textContent, /Ready/);
});

test("the eight-area/four-readable screenshot is shown as incomplete capture", async () => {
  const { nodes } = popupOn("https://gemini.google.com/app/test", null, {
    page: { ok: true, provider: "gemini", conversationId: "test", lastScanAt: "2026-10-02T00:00:00Z", lastScanCandidates: 8, lastScanReadable: 4, lastScanStored: 0 },
    localCount: 4
  });
  await settle();
  assert.equal(nodes.get("#page-status").textContent, "Some messages could not be read.");
  assert.match(nodes.get("#repair-count").textContent, /4 saved/);
});


test("a rejected chat repair remains visible after runtime errors become exceptions", async () => {
  const {nodes}=popupOn("https://gemini.google.com/app/test-chat",null,{
    repairError:"Saved messages could not be queued.",localCount:2,
    status:{settings:{captureEnabled:true},captureStats:{},ingestion:{enabled:true,hasAccessToken:true,quarantinedBatches:1}},
    page:{ok:true,provider:"gemini",conversationId:"test-chat"}
  });
  await settle();await nodes.get("#repair-chat").listeners.click();
  assert.match(nodes.get("#repair-status").textContent,/not queued/i);
  assert.match(nodes.get("#error").textContent,/could not be queued/i);
});
