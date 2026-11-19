import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const coreSource = await readFile(new URL("../src/core.js", import.meta.url), "utf8");
const source = await readFile(new URL("../src/web-provider-adapter.js", import.meta.url), "utf8");
const settle = async () => { for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve)); };

function page({ send, settings, extractText, provider = "gemini" } = {}) {
  class Turn {
    constructor(n, text = `Invented message ${n}`) { this.n = n; this.innerText = text; this.textContent = text; }
    matches() { return true; }
    closest() { return this; }
    querySelectorAll() { return []; }
    contains(other) { return other === this; }
  }
  let turns = [];
  let listener;
  let observer;
  const intervals = new Map();
  const timers = new Map();
  const domEvents = {};
  const sent = [];
  const location = { href: provider === "claude" ? "https://claude.ai/chat/existing" : "https://gemini.google.com/app", origin: provider === "claude" ? "https://claude.ai" : "https://gemini.google.com", pathname: "/app" };
  const browser = {
    storage: { sync: { get: async (defaults) => settings ? settings(defaults) : defaults } },
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) {
        sent.push(message);
        if (send) return send(message);
        return { ok: true, result: { added: message.payload?.events?.length || 0 } };
      }
    }
  };
  const context = vm.createContext({ browser, location, URL, Element: Turn,
    document: { title: "Invented Gemini chat", body: {}, visibilityState: "visible", querySelectorAll: () => turns, addEventListener: (type, fn) => { domEvents[type] = fn; } },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} disconnect() {} },
    performance: { now: () => 1 },
    setInterval: (fn, delay) => intervals.set(delay, fn),
    setTimeout: (fn, delay) => { const id = {}; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(coreSource, context);
  vm.runInContext(source, context);
  return {
    sent, intervals, location, context,
    setTurns(count, blank = false) { turns = Array.from({ length: count }, (_, n) => new Turn(n, blank ? "" : undefined)); },
    hideFirst(count) { turns.slice(0, count).forEach((turn) => { turn.innerText = ""; }); },
    start() { context.SharedMemoryWebProviderAdapter.start({ provider, turnSelector: "user-query,model-response", detectRole: (turn) => turn.n % 2 ? "assistant" : "user", findMessageNode: (turn) => turn, extractText, getProviderMessageId: (turn) => `message-${turn.n}` }); },
    async scan() { intervals.get(5000)(); await settle(); },
    async navigate(url) { location.href = url; intervals.get(1000)(); await settle(); },
    async mutate() {
      observer([{ type: "childList", target: turns[0], addedNodes: turns }]);
      for (const timer of [...timers.values()]) if (timer.delay <= 900) await timer.fn();
      await settle();
    },
    async state() { return new Promise((resolve) => listener({ type: "GET_CAPTURE_STATE" }, {}, resolve)); },
    async report() { return new Promise((resolve) => listener({ type: "GET_CAPTURE_DIAGNOSTICS" }, {}, resolve)); }
  };
}

test("new Gemini chat captures eight messages through startup, navigation and page changes with no popup", async () => {
  const p = page();
  p.setTurns(2);
  p.start();
  await settle();
  assert.equal(p.sent.filter((m) => m.type === "CAPTURE_BATCH")[0].payload.events.length, 2);
  await p.navigate("https://gemini.google.com/app/permanent-id");
  assert.equal(p.sent.filter((m) => m.type === "REKEY_CONVERSATION").length, 1);
  p.setTurns(8);
  await p.mutate();
  const canonicalEvents = p.sent.filter((m) => m.type === "CAPTURE_BATCH").flatMap((m) => m.payload.events).filter((e) => e.conversationId === "permanent-id");
  assert.equal(canonicalEvents.length, 8);
  assert.equal(new Set(canonicalEvents.map((e) => e.eventId)).size, 8);
  await p.scan();
  assert.equal(p.sent.filter((m) => m.type === "CAPTURE_BATCH").length, 3);
});

test("a temporary settings failure recovers automatically and still respects capture off", async () => {
  let fail = true;
  let enabled = false;
  const p = page({ settings: (defaults) => { if (fail) throw new Error("background starting"); return { ...defaults, captureEnabled: enabled }; } });
  p.setTurns(2); p.start(); await settle();
  assert.equal(p.intervals.size, 2);
  fail = false;
  await p.scan();
  assert.equal(p.sent.filter((m) => m.type === "CAPTURE_BATCH").length, 0);
  enabled = true;
  await p.navigate("https://gemini.google.com/app/recovered");
  assert.equal(p.sent.filter((m) => m.type === "CAPTURE_BATCH").length, 1);
});

test("an absent acknowledgement does not suppress the next automatic capture", async () => {
  let attempts = 0;
  const p = page({ send: (message) => {
    if (message.type === "CAPTURE_BATCH" && ++attempts === 1) return undefined;
    return { ok: true, result: { added: message.payload?.events?.length || 0 } };
  } });
  p.setTurns(2); p.start(); await settle();
  assert.match((await p.state()).lastError, /did not confirm/);
  await p.scan();
  assert.equal(attempts, 2);
  assert.equal((await p.state()).lastError, null);
  await p.scan();
  assert.equal(attempts, 2);
});

test("messages whose text loads late are picked up by the automatic rescan", async () => {
  const p = page();
  p.setTurns(8, true); p.start(); await settle();
  assert.equal(p.sent.filter((m) => m.type === "CAPTURE_BATCH").length, 0);
  p.setTurns(8);
  await p.scan();
  assert.equal(p.sent.filter((m) => m.type === "CAPTURE_BATCH")[0].payload.events.length, 8);
});

test("one unreadable message does not block the others and is retried on the next full scan", async () => {
  let broken = true;
  const p = page({ extractText: (node) => {
    if (broken && node.n === 2) throw new Error("unreadable node");
    return node.innerText;
  } });
  p.setTurns(8); p.start(); await settle();
  const batches = () => p.sent.filter((message) => message.type === "CAPTURE_BATCH");
  assert.equal(batches()[0].payload.events.length, 7);
  assert.match((await p.state()).lastError, /1 message could not be read/);
  broken = false;
  await p.scan();
  assert.equal(batches()[1].payload.events.length, 1);
  assert.equal(batches()[1].payload.events[0].sequence, 2);
  assert.equal((await p.state()).lastError, null);
  await p.scan();
  assert.equal(batches().length, 2);
});

test("failed conversation reconciliation is retried before acknowledging the new address", async () => {
  let rekeys = 0;
  const p = page({ send: (message) => {
    if (message.type === "REKEY_CONVERSATION" && ++rekeys === 1) return { ok: false, error: "temporary storage failure" };
    return { ok: true, result: { added: message.payload?.events?.length || 0 } };
  } });
  p.setTurns(2); p.start(); await settle();
  await p.navigate("https://gemini.google.com/app/permanent-id");
  assert.equal(rekeys, 1);
  await p.scan();
  assert.equal(rekeys, 2);
  assert.equal((await p.state()).conversationId, "permanent-id");
});

test("separate new chat tabs do not share provisional conversation IDs", async () => {
  const left = page(); const right = page();
  left.setTurns(2); right.setTurns(2); left.start(); right.start(); await settle();
  assert.notEqual((await left.state()).conversationId, (await right.state()).conversationId);
});

test("troubleshooting distinguishes loaded but unrendered messages without exporting their text", async () => {
  const p = page();
  p.setTurns(8); p.hideFirst(4); p.start(); await settle();
  const state = await p.state();
  assert.equal(state.lastScanCandidates, 8);
  assert.equal(state.lastScanReadable, 4);
  const { diagnostics } = await p.report();
  assert.equal(diagnostics.messageAreaCount, 8);
  assert.ok(diagnostics.messageAreas.slice(0, 4).every((area) => area.renderedCharacters === 0 && area.loadedCharacters > 0));
  assert.ok(diagnostics.messageAreas.slice(4).every((area) => area.renderedCharacters > 0));
  assert.doesNotMatch(JSON.stringify(diagnostics), /Invented message|conversationId|https:\/\//);
});

for (const provider of ["gemini", "claude"]) {
  test(`${provider} sends a title-only observation when text is unchanged and skips repeated titles`, async () => {
    const p = page({ provider }); p.location.href = provider === "claude" ? "https://claude.ai/chat/existing" : "https://gemini.google.com/app/existing";
    p.setTurns(2); p.start(); await settle();
    const batches = () => p.sent.filter(m => m.type === "CAPTURE_BATCH");
    assert.equal(batches()[0].payload.events[0].sourceMetadata.conversationIdentity, "provider");
    const initialCount = batches().length;
    p.context.document.title = "Renamed source topic";
    await p.scan();
    const updates = () => p.sent.filter(m => m.type === "CONVERSATION_METADATA");
    assert.equal(updates().at(-1).payload.chatTitle, "Renamed source topic");
    assert.equal(updates().at(-1).payload.sourceMetadata.timestampBasis, "unknown");
    const count = updates().length;
    await p.scan();
    assert.equal(updates().length, count);
    assert.equal(batches().length, initialCount);
  });
}
