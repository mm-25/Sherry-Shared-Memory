import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectChatGptSnapshot } from "../chatgpt-collector.js";
import { parseChatGptAxSnapshot, resolveLocalChatGptIdentity } from "../chatgpt-ax.js";
import { setCapturePaused } from "../controls.js";
import { observeChatGptOnce } from "../service.js";
import { bindWorkspace, EncryptedStateStore } from "../state.js";
import { validateCaptureBatch } from "../../backend/src/validation.js";

const workspaceId = "f240c121-52d7-45dd-a2d3-8c4743e77955";
const userText = "Please plan a small garden with lavender, thyme, and a shaded seating area.";
const source = JSON.stringify({
  kind: "chatgpt_ax_snapshot_v1",
  surface: "chatgpt",
  title: "Garden plan",
  truncated: false,
  turns: [
    { role: "user", parts: [{ block: 1, text: "Please plan a small garden " },
      { block: 1, text: "with lavender, thyme, and a shaded seating area." }] },
    { role: "assistant", parts: [{ block: 2, text: "Plant lavender and thyme." },
      { block: 3, text: "Add a bench under the tree." }] }
  ]
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "sherry-chatgpt-ax-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new EncryptedStateStore(join(home, "state"), randomBytes(32));
  return { home, store };
}

test("AX fragments normalize to visible turns and reject incomplete snapshots", () => {
  const parsed = parseChatGptAxSnapshot(source);
  assert.deepEqual(parsed.turns.map((turn) => turn.role), ["user", "assistant"]);
  assert.equal(parsed.turns[0].text, userText);
  assert.equal(parsed.turns[1].text, "Plant lavender and thyme. Add a bench under the tree.");
  assert.throws(() => parseChatGptAxSnapshot({ ...JSON.parse(source), truncated: true }), /truncated/);
  assert.throws(() => parseChatGptAxSnapshot('{"private message":"unfinished'), /not valid JSON/);
});

test("Codex and unidentified shared-shell transcripts never enter the ChatGPT queue", async (t) => {
  const { store } = await fixture(t);
  for (const surface of [undefined, "codex", "unknown"]) {
    const state = await store.load();
    const raw = { ...JSON.parse(source), surface };
    await assert.rejects(collectChatGptSnapshot(state, store, raw, { workspaceId, deviceId: "test" }), /source is unverified/);
    assert.equal(state.pending.length, 0);
    assert.equal(state.recentCaptures.length, 0);
    assert.equal(state.chatgptIdentities.length, 0);
  }
});

test("local registry keeps a ChatGPT identity across rescans without using the title alone", () => {
  const state = { chatgptIdentities: [] };
  const parsed = parseChatGptAxSnapshot(source);
  assert.throws(() => resolveLocalChatGptIdentity(state, { ...parsed, turns: [parsed.turns[0]] }), /second visible turn/);
  const id = resolveLocalChatGptIdentity(state, parsed);
  assert.equal(resolveLocalChatGptIdentity(state, parsed), id);
  const other = { ...parsed, turns: [{ role: "user", text: "A completely different conversation about a trip to Japan." },
    { role: "assistant", text: "Plan the train routes and hotels." }] };
  assert.notEqual(resolveLocalChatGptIdentity(state, other), id);
});

test("ChatGPT snapshot enters the encrypted v2 queue once and stays private", async (t) => {
  const { home, store } = await fixture(t);
  const state = await store.load();
  bindWorkspace(state, workspaceId);
  const options = { workspaceId, deviceId: "device_test12345", now: () => "2026-10-01T12:00:00.000Z" };
  const first = await collectChatGptSnapshot(state, store, source, options);
  assert.equal(first.addedEvents, 2);
  assert.equal(state.pending.length, 1);
  assert.equal(validateCaptureBatch(state.pending[0].batch).ok, true);
  assert.equal(state.pending[0].batch.events[0].text, userText);
  assert.equal(state.pending[0].batch.events[0].sourceUrl, null);
  const encrypted = await readFile(join(home, "state", "queue.json.enc"), "utf8");
  assert.ok(!encrypted.includes(userText));
  const second = await collectChatGptSnapshot(state, store, source, options);
  assert.equal(second.addedEvents, 0);
  assert.equal(second.localConversationId, first.localConversationId);
});

test("a full queue leaves ChatGPT message identities retriable", async (t) => {
  const { store } = await fixture(t);
  const state = await store.load();
  bindWorkspace(state, workspaceId);
  state.pending = Array.from({ length: 100 }, (_, index) => ({ batch: { batchId: `held-${index}` } }));
  const result = await collectChatGptSnapshot(state, store, source, {
    workspaceId, deviceId: "device_test12345"
  });
  assert.equal(result.addedEvents, 0);
  assert.equal(Object.keys(state.seen).length, 0);
  assert.match(state.lastError, /queue is full/);
});

test("paused ChatGPT observation never invokes the native reader", async (t) => {
  const { home, store } = await fixture(t);
  await setCapturePaused(home, true);
  const earlier = process.env.SHERRY_EXPERIMENTAL_CHATGPT_AX;
  process.env.SHERRY_EXPERIMENTAL_CHATGPT_AX = "1";
  try {
    await assert.rejects(observeChatGptOnce({ home, workspaceId, deviceId: "device_test12345" }, store,
      async () => { throw new Error("reader should not run"); }), /Enable desktop capture/);
  } finally {
    if (earlier == null) delete process.env.SHERRY_EXPERIMENTAL_CHATGPT_AX;
    else process.env.SHERRY_EXPERIMENTAL_CHATGPT_AX = earlier;
  }
});

test("manual ChatGPT observation stores only encrypted turns and redacted status", async (t) => {
  const { home, store } = await fixture(t);
  await setCapturePaused(home, false);
  const earlier = process.env.SHERRY_EXPERIMENTAL_CHATGPT_AX;
  process.env.SHERRY_EXPERIMENTAL_CHATGPT_AX = "1";
  try {
    const result = await observeChatGptOnce({ home, workspaceId, deviceId: "device_test12345",
      endpoint: null, accessToken: null }, store, async () => source);
    assert.equal(result.addedEvents, 2);
    assert.equal((await store.load()).pending.length, 1);
    assert.ok(!(await readFile(join(home, "status.json"), "utf8")).includes(userText));
  } finally {
    if (earlier == null) delete process.env.SHERRY_EXPERIMENTAL_CHATGPT_AX;
    else process.env.SHERRY_EXPERIMENTAL_CHATGPT_AX = earlier;
  }
});
