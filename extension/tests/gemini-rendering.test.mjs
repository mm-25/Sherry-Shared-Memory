import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const core = await readFile(new URL("../src/core.js", import.meta.url), "utf8");
const shared = await readFile(new URL("../src/web-provider-adapter.js", import.meta.url), "utf8");
const gemini = await readFile(new URL("../src/gemini-adapter.js", import.meta.url), "utf8");
const settle = async () => { for (let n = 0; n < 8; n++) await new Promise((resolve) => setImmediate(resolve)); };

class Node {
  constructor(tag, { parent = null, auto = false, skipped = false, text = "", loaded = text } = {}) {
    Object.assign(this, { nodeType: 1, tagName: tag.toUpperCase(), parentElement: parent, auto, skipped, text, loaded });
    this.childNodes = [{ nodeType: 3, textContent: loaded }];
    this.attributes = new Map();
    this.properties = new Map();
    this.style = {
      getPropertyValue: (name) => this.properties.get(name)?.value || "",
      getPropertyPriority: (name) => this.properties.get(name)?.priority || "",
      setProperty: (name, value, priority = "") => { this.properties.set(name, { value, priority }); this.attributes.set("style", [...this.properties.keys()].join(";")); },
      removeProperty: (name) => { this.properties.delete(name); this.attributes.set("style", [...this.properties.keys()].join(";")); }
    };
  }
  get innerText() {
    for (let node = this; node; node = node.parentElement) {
      if (node.skipped && node.computed().contentVisibility === "auto") return "";
    }
    if (this.throwOnRead) throw new Error("render read failed");
    if (this.forceBlank) return "";
    return this.text;
  }
  get textContent() { return this.loaded; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  computed() { return { display: this.display || "block", visibility: this.visibility || "visible", contentVisibility: this.style.getPropertyValue("content-visibility") || (this.auto ? "auto" : "visible") }; }
  contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
  querySelector(selector) { return selector === ".query-text" || selector === ".model-response-text" ? this.message : null; }
  querySelectorAll(selector) { return this.queryMatches?.[selector] || []; }
}

function turn(n, skipped = true) {
  const outer = new Node("div", { auto: true, skipped });
  const element = new Node(n % 2 ? "model-response" : "user-query", { parent: outer });
  element.message = new Node("div", { parent: element, text: `Invented message ${n}\n\nSecond paragraph`, loaded: `Invented message ${n}Second paragraphHidden controls` });
  return element;
}

function config() {
  let result;
  const context = vm.createContext({ getComputedStyle: (node) => node.computed(), SharedMemoryWebProviderAdapter: { start: (value) => { result = value; } } });
  vm.runInContext(core, context);
  vm.runInContext(gemini, context);
  return result;
}

function read(c, t) { return c.extractText(c.findMessageNode(t, c.detectRole(t)) || t, t); }

test("Gemini reads skipped loaded messages with the same formatting as visible messages", () => {
  const c = config(); const t = turn(0);
  assert.equal(t.message.innerText, "");
  const text = read(c, t);
  assert.equal(text, "Invented message 0\n\nSecond paragraph");
  assert.doesNotMatch(text, /Hidden controls/);
  assert.equal(t.parentElement.computed().contentVisibility, "auto");
  assert.equal(t.parentElement.hasAttribute("style"), false);
  t.parentElement.skipped = false;
  assert.equal(read(c, t), text);
});

test("Gemini restores nested inline content-visibility values, priorities and other styles", () => {
  const c = config(); const t = turn(1);
  const outer = t.parentElement;
  outer.style.setProperty("color", "red");
  outer.style.setProperty("content-visibility", "auto", "important");
  t.auto = true; t.skipped = true;
  assert.match(read(c, t), /Invented message 1/);
  assert.equal(outer.style.getPropertyValue("content-visibility"), "auto");
  assert.equal(outer.style.getPropertyPriority("content-visibility"), "important");
  assert.equal(outer.style.getPropertyValue("color"), "red");
  assert.equal(t.hasAttribute("style"), false);
});

test("Gemini falls back to the known loaded body when rendered text throws and restores styles", () => {
  const c = config(); const t = turn(2); t.message.throwOnRead = true;
  t.message.childNodes = [{ nodeType: 3, textContent: "Invented message 2" }];
  assert.equal(read(c, t), "Invented message 2");
  assert.equal(t.parentElement.computed().contentVisibility, "auto");
  assert.equal(t.parentElement.hasAttribute("style"), false);
});

test("Gemini loaded-text fallback skips hidden controls and keeps paragraph boundaries", () => {
  const c = config(); const t = turn(0); t.message.forceBlank = true;
  const first = new Node("p", { parent: t.message, loaded: "First paragraph" });
  const second = new Node("p", { parent: t.message, loaded: "Second paragraph" });
  const hidden = new Node("span", { parent: t.message, loaded: "Private interface text" });
  hidden.attributes.set("aria-hidden", "true");
  const button = new Node("button", { parent: t.message, loaded: "Copy" });
  t.message.childNodes = [first, second, hidden, button];
  assert.equal(read(c, t), "First paragraph\nSecond paragraph");
  assert.equal(t.parentElement.hasAttribute("style"), false);
});

test("Gemini does not read intentionally hidden messages or an unknown response wrapper", () => {
  const c = config();
  for (const hide of [
    (node) => node.attributes.set("hidden", ""),
    (node) => node.attributes.set("aria-hidden", "true"),
    (node) => { node.display = "none"; },
    (node) => { node.visibility = "hidden"; },
    (node) => node.style.setProperty("content-visibility", "hidden")
  ]) {
    const t = turn(0); hide(t.message);
    assert.equal(read(c, t), "");
    assert.equal(t.parentElement.hasAttribute("style"), false);
  }
  const t = turn(1); t.message = null; t.text = "Copy Regenerate Hidden controls";
  assert.equal(read(c, t), "");
});

test("actual Gemini startup captures all eight messages without popup and rescans add no copies", async () => {
  const turns = Array.from({ length: 8 }, (_, n) => turn(n, n < 4));
  const sent = [];
  const intervals = new Map();
  let listener;
  const context = vm.createContext({
    getComputedStyle: (node) => node.computed(), Element: Node, URL,
    location: { href: "https://gemini.google.com/app/invented-test" },
    document: { title: "Invented test", body: {}, visibilityState: "visible", querySelectorAll: () => turns, querySelector: () => null, addEventListener() {} },
    browser: {
      storage: { sync: { get: async (defaults) => defaults } },
      runtime: { onMessage: { addListener(fn) { listener = fn; } }, sendMessage: async (message) => { sent.push(message); return { ok: true, result: { added: message.payload?.events?.length || 0 } }; } }
    },
    MutationObserver: class { observe() {} disconnect() {} }, performance: { now: () => 1 },
    setTimeout: () => ({}), clearTimeout() {}, setInterval: (fn, delay) => intervals.set(delay, fn)
  });
  vm.runInContext(core, context); vm.runInContext(shared, context); vm.runInContext(gemini, context);
  await settle();
  const batches = () => sent.filter((m) => m.type === "CAPTURE_BATCH");
  assert.equal(batches().length, 1);
  assert.equal(batches()[0].payload.events.length, 8);
  assert.deepEqual(Array.from(batches()[0].payload.events, (e) => e.sequence), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(batches()[0].payload.events.map((e) => e.eventId)).size, 8);
  const state = await new Promise((resolve) => listener({ type: "GET_CAPTURE_STATE" }, {}, resolve));
  assert.equal(state.lastScanReadable, 8);
  intervals.get(5000)(); await settle();
  turns.forEach((t) => { t.parentElement.skipped = false; });
  intervals.get(5000)(); await settle();
  assert.equal(batches().length, 1);
  assert.ok(turns.every((t) => !t.parentElement.hasAttribute("style")));
});


test("Gemini reads actual prompt lines once and excludes the repeated accessibility heading", () => {
  const c = config();
  for (const skipped of [false, true]) {
    const t = turn(0, skipped);
    t.message.text = "You said First prompt line Second prompt line\nFirst prompt line\nSecond prompt line";
    t.message.loaded = t.message.text;
    const first = new Node("p", { parent: t.message, text: "First prompt line" });
    const second = new Node("p", { parent: t.message, text: "Second prompt line" });
    t.message.queryMatches = { ".query-text-line": [first, second] };
    assert.equal(read(c, t), "First prompt line\nSecond prompt line");
    assert.equal(t.parentElement.hasAttribute("style"), false);
  }
});

test("Gemini reads visible message bodies when only the application shell has aria-hidden", () => {
  const c = config(); const t = turn(0, false);
  const shell = new Node("chat-app-orchestrator"); shell.attributes.set("aria-hidden", "true");
  t.parentElement.parentElement = shell;
  assert.equal(read(c,t), "Invented message 0\n\nSecond paragraph");
  shell.attributes.set("inert", "");
  assert.equal(read(c,t), "", "inert application content still cannot be read");
  shell.attributes.delete("inert");shell.display="none";
  assert.equal(read(c,t), "", "actually hidden shell still cannot be read");
});
