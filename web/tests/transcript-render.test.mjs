import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
function section(start, end) { return app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start))); }
function element() {
  return { children: [], dataset: {}, classList: { add() {} }, append(...children) { this.children.push(...children); } };
}

test("the actual transcript renderer wires source dates, speaker labels and unchanged text", async () => {
  const messages = { querySelector: () => null, replaceChildren(...items) { this.children = items; } };
  const elements = { messages, transcriptSort: { value: "oldest" } };
  const context = { document: { createElement: element, getElementById: (id) => elements[id] } };
  for (const file of ["transcript-order.js", "capture-presentation.js"]) {
    vm.runInNewContext(await readFile(new URL("../" + file, import.meta.url), "utf8"), context);
  }
  vm.runInNewContext(`
    ${app.slice(0, app.indexOf("const isPreview"))}
    let selected = { provider: "chatgpt", events: [
      { id: "u", role: "user", sequence: 1, text_content: "Invented <b>plain text</b>", captured_at: "2026-10-28T19:00:00Z", source_locator: "android-session:test" },
      { id: "a", role: "assistant", sequence: 2, text_content: "Invented reply", captured_at: "2026-10-28T19:00:01Z", source_locator: "android-session:test" }
    ] };
    ${section("function providerLabel(", "function platformLabel(")}
    ${section("function formatDateTime(", "function conversationActivityAt(")}
    ${section("function isTransientTranscriptEvent(", "function truncateText(")}
    ${section("function renderTranscriptMessages(", "async function openConversation(")}
    renderTranscriptMessages(null);
  `, context);
  assert.equal(messages.children.length, 2);
  assert.equal(messages.children[0].children[0].textContent, "You");
  assert.equal(messages.children[1].children[0].textContent, "ChatGPT");
  assert.equal(messages.children[0].children[1].textContent, "Invented <b>plain text</b>");
  assert.match(messages.children[0].children[2].textContent, /Original date unknown · observed/);
});
