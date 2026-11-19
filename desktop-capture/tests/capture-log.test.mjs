import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EncryptedStateStore } from "../state.js";
import { collectCodexChanges } from "../collector.js";
import { collectChatGptSnapshot } from "../chatgpt-collector.js";
import { collectClaudeDesktopSnapshot } from "../claude-desktop-collector.js";
import { uploadPending } from "../uploader.js";
import { recordCapturedBatch, captureLogView, CAPTURE_LOG_LIMIT, CAPTURE_LOG_BYTES } from "../capture-log.js";

const confirmed = (request) => {
  const batch = JSON.parse(request.body);
  return { ok: true, status: 200, json: async () => ({ ok: true, batchId: batch.batchId,
    result: { status: "committed", received: batch.events.length, inserted: batch.events.length, updated: 0, duplicates: 0 } }) };
};

const workspaceId = "f240c121-52d7-45dd-a2d3-8c4743e77955";
const sessionId = "a73cd68b-bd48-46ea-a2fe-b61238d23d09";
const when = "2026-10-02T12:00:00.000Z";
const options = { workspaceId, deviceId: "device_test12345", now: () => when };

test("actual capture remains visible after upload and local preview never exposes account credentials", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "sherry-log-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new EncryptedStateStore(join(home, "state"), randomBytes(32));
  const state = await store.load();
  state.connection = { accessToken: "secret-account-token", refreshToken: "private-refresh-token" };
  const row = (type, payload) => JSON.stringify({ type, payload, timestamp: when });
  await writeFile(join(home, "session.jsonl"), [
    row("session_meta", { id: sessionId, source: "vscode", thread_source: "user" }),
    row("response_item", { type: "message", id: "u1", role: "user",
      content: [{ type: "input_text", text: "Private user test message" }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } }),
    row("response_item", { type: "message", id: "a1", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "Private assistant reply" }] })
  ].join("\n"));
  const settings = { ...options, sessionsDir: home, captureFrom: when };
  assert.equal((await collectCodexChanges(state, store, settings)).addedEvents, 2);
  assert.equal((await collectCodexChanges(state, store, settings)).addedEvents, 0);
  assert.equal(state.recentCaptures.length, 2);
  assert.equal(state.recentCaptures[0].delivery, "queued");
  const upload = { endpoint: "https://example.org", accessToken: "fake", now: () => new Date(when) };
  await uploadPending(state, store, { ...upload, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(state.recentCaptures[0].delivery, "retrying");
  assert.match(state.recentCaptures[0].error, /503/);
  await uploadPending(state, store, { ...upload, now: () => new Date("2026-10-02T12:01:00.000Z"),
    fetchImpl: async (_url, request) => confirmed(request) });
  assert.equal(state.pending.length, 0);
  const saved = await store.load();
  assert.equal(saved.recentCaptures.length, 2);
  assert.deepEqual(saved.recentCaptures.map((item) => item.delivery), ["uploaded", "uploaded"]);
  assert.equal(saved.recentCaptures[0].event.text, "Private user test message");
  const view = JSON.stringify(captureLogView(saved));
  assert.ok(!view.includes("secret-account-token"));
  assert.ok(!view.includes("private-refresh-token"));
  assert.ok(!(await readFile(store.filename, "utf8")).includes("Private user test message"));
});

test("old revision upload cannot mark the newer captured text as uploaded", async () => {
  const state = { pending: [], recentCaptures: [], quarantined: [] };
  const batch = (batchId, text) => ({ batchId, provider: "codex", clientCreatedAt: when,
    events: [{ eventId: "same-event", text, capturedAt: when }] });
  const oldBatch = batch("old", "Earlier answer");
  recordCapturedBatch(state, oldBatch);
  recordCapturedBatch(state, batch("new", "Corrected answer"));
  state.pending.push({ batch: oldBatch, attempts: 0 });
  await uploadPending(state, { save: async () => {} }, { endpoint: "https://example.org", accessToken: "fake",
    fetchImpl: async (_url, request) => confirmed(request) });
  assert.equal(state.recentCaptures.length, 1);
  assert.equal(state.recentCaptures[0].event.text, "Corrected answer");
  assert.equal(state.recentCaptures[0].delivery, "queued");
});

test("preview retention is bounded per app and one busy source cannot remove another source", () => {
  const state = {};
  for (const provider of ["codex", "antigravity", "chatgpt", "claude"]) {
    recordCapturedBatch(state, { provider, batchId: provider, clientCreatedAt: when,
      events: Array.from({ length: 70 }, (_, i) => ({ eventId: `${provider}-${i}`, text: `Message ${i}` })) });
  }
  for (const source of ["codex", "antigravity", "chatgpt", "claude"]) {
    assert.equal(state.recentCaptures.filter((item) => item.source === source).length, CAPTURE_LOG_LIMIT);
  }
  recordCapturedBatch(state, { provider: "codex", batchId: "large", clientCreatedAt: when,
    events: Array.from({ length: 30 }, (_, i) => ({ eventId: `large-${i}`, text: "x".repeat(200_000) })) });
  const codex = state.recentCaptures.filter((item) => item.source === "codex");
  assert.ok(codex.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0) <= CAPTURE_LOG_BYTES);
  assert.equal(codex.at(-1).event.eventId, "large-29");
  assert.equal(state.recentCaptures.filter((item) => item.source === "claude").length, CAPTURE_LOG_LIMIT);
});

test("rejected uploads remain visible with their HTTP error", async () => {
  const batch = { provider: "antigravity", batchId: "invalid", clientCreatedAt: when,
    events: [{ eventId: "one", text: "Captured message" }] };
  const state = { pending: [{ batch, attempts: 0 }], quarantined: [] };
  recordCapturedBatch(state, batch);
  await uploadPending(state, { save: async () => {} }, { endpoint: "https://example.org", accessToken: "fake",
    fetchImpl: async () => ({ ok: false, status: 422 }) });
  assert.equal(state.pending.length, 0);
  assert.equal(state.recentCaptures[0].delivery, "rejected");
  assert.equal(state.recentCaptures[0].httpStatus, 422);
});

test("both Accessibility collectors feed the local Test view", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "sherry-ax-log-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new EncryptedStateStore(home, randomBytes(32));
  const state = await store.load();
  await collectChatGptSnapshot(state, store, { kind: "chatgpt_ax_snapshot_v1", surface: "chatgpt", title: "Chat", truncated: false,
    turns: [{ role: "user", parts: [{ block: 1, text: "A prompt" }] },
      { role: "assistant", parts: [{ block: 2, text: "A reply" }] }] }, options);
  await collectClaudeDesktopSnapshot(state, store, { kind: "claude_ax_snapshot_v1",
    sourceURL: `app://localhost/chat/${sessionId}`, truncated: false,
    turns: [{ role: "user", text: "Claude prompt" }, { role: "assistant", text: "Claude reply" }] }, options);
  assert.deepEqual(state.recentCaptures.map((item) => item.source), ["chatgpt", "chatgpt", "claude", "claude"]);
  assert.ok(state.recentCaptures.filter((item) => item.source === "chatgpt").every((item) => item.sourceVerified === true));
});
