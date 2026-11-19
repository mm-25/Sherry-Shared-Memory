import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectCodexChanges } from "../collector.js";
import { isCaptureEpochActive, readControls, setCapturePaused, setSourceEnabled } from "../controls.js";
import { bindWorkspace, EncryptedStateStore } from "../state.js";
import { uploadPending } from "../uploader.js";
import { runCaptureCycle } from "../service.js";

const confirmed = (request) => {
  const batch = JSON.parse(request.body);
  return { ok: true, status: 200, json: async () => ({ ok: true, batchId: batch.batchId,
    result: { status: "committed", received: batch.events.length, inserted: batch.events.length, updated: 0, duplicates: 0 } }) };
};

const workspaceId = "f240c121-52d7-45dd-a2d3-8c4743e77955";
const sessionId = "a73cd68b-bd48-46ea-a2fe-b61238d23d09";
const at = "2026-10-01T12:00:01.000Z";
const row = (type, payload, timestamp = at) => JSON.stringify({ type, payload, timestamp });

function session(id = sessionId, owner = true, text = "Capture this conversation") {
  return [
    row("session_meta", { id, cli_version: "1.0", thread_source: owner ? "user" : "guardian_review",
      source: owner ? "vscode" : { subagent: { other: "guardian" } } }),
    row("response_item", { type: "message", id: "u1", role: "user",
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } }),
    row("response_item", { type: "message", id: "a1", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "Captured reply" }] })
  ].join("\n") + "\n";
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "sherry-desktop-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessionsDir = join(home, "sessions", "2026", "10", "01");
  await mkdir(sessionsDir, { recursive: true });
  const store = new EncryptedStateStore(join(home, "state"), randomBytes(32));
  return { home, sessionsDir: join(home, "sessions"), dayDir: sessionsDir, store };
}

test("queue is encrypted, private, and rejects a wrong key", async (t) => {
  const { home, store } = await fixture(t);
  const state = await store.load();
  state.pending.push({ batch: { secret: "private conversation text" }, attempts: 0 });
  await store.save(state);
  const filename = join(home, "state", "queue.json.enc");
  const bytes = await readFile(filename, "utf8");
  assert.ok(!bytes.includes("private conversation text"));
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.deepEqual((await store.load()).pending, state.pending);
  await assert.rejects(new EncryptedStateStore(join(home, "state"), randomBytes(32)).load());
});

test("an old enabled ChatGPT switch cannot resume mislabeled desktop capture", async (t) => {
  const { home } = await fixture(t);
  const controls = await setCapturePaused(home, false, at);
  const filename = join(home, "controls.json");
  await writeFile(filename, JSON.stringify({ ...controls, sources: { ...controls.sources,
    chatgpt: { enabled: true, captureFrom: at }, claude: { enabled: true, captureFrom: at }
  } }));
  const loaded = await readControls(home);
  assert.equal(loaded.sources.chatgpt.enabled, false);
  assert.equal(loaded.sources.claude.enabled, true);
  await assert.rejects(setSourceEnabled(home, "chatgpt", true), /cannot yet separate ChatGPT from Codex/);
  assert.equal((await readControls(home)).sources.chatgpt.enabled, false);
});

test("collector keeps only eligible user-owned events and deduplicates rescans", async (t) => {
  const { dayDir, sessionsDir, store } = await fixture(t);
  await writeFile(join(dayDir, `rollout-${sessionId}.jsonl`), session());
  await writeFile(join(dayDir, "review.jsonl"), session("b73cd68b-bd48-46ea-a2fe-b61238d23d09", false));
  const state = await store.load();
  const options = { sessionsDir, workspaceId, deviceId: "device_test12345",
    captureFrom: "2026-10-01T12:00:00.000Z", now: () => "2026-10-01T12:05:00.000Z" };
  const first = await collectCodexChanges(state, store, options);
  assert.equal(first.addedEvents, 2);
  assert.equal(first.pendingBatches, 1);
  assert.equal(state.pending[0].batch.events.length, 2);
  assert.equal(state.pending[0].batch.events[0].messageTimestamp, at);
  assert.equal(state.pending[0].batch.events[0].capturedAt, "2026-10-01T12:05:00.000Z");
  const second = await collectCodexChanges(state, store, options);
  assert.equal(second.addedEvents, 0);
  assert.equal(state.pending.length, 1);
});

test("queue limits never mark unqueued messages as captured", async (t) => {
  const { dayDir, sessionsDir, store } = await fixture(t);
  await writeFile(join(dayDir, `a-${sessionId}.jsonl`), session());
  await writeFile(join(dayDir, "z-b73cd68b-bd48-46ea-a2fe-b61238d23d09.jsonl"),
    session("b73cd68b-bd48-46ea-a2fe-b61238d23d09", true, "A second conversation"));
  const state = await store.load();
  const options = { sessionsDir, workspaceId, deviceId: "device_test12345",
    captureFrom: "2026-10-01T12:00:00.000Z", maxPendingBatches: 1 };
  const first = await collectCodexChanges(state, store, options);
  assert.equal(first.queueFull, true);
  assert.equal(first.addedEvents, 2);
  state.pending = [];
  await store.save(state);
  const second = await collectCodexChanges(state, store, options);
  assert.equal(second.addedEvents, 2);
  assert.equal(state.pending.length, 1);
});

test("explicit backfill adds older unseen turns from one file", async (t) => {
  const { dayDir, sessionsDir, store } = await fixture(t);
  const filename = join(dayDir, `rollout-${sessionId}.jsonl`);
  await writeFile(filename, session());
  const state = await store.load();
  const live = await collectCodexChanges(state, store, { sessionsDir, workspaceId,
    deviceId: "device_test12345", captureFrom: "2026-10-01T13:00:00.000Z" });
  assert.equal(live.addedEvents, 0);
  const backfill = await collectCodexChanges(state, store, { sessionsDir, workspaceId,
    deviceId: "device_test12345", captureFrom: "1970-01-01T00:00:00.000Z",
    files: [filename], ignoreFingerprint: true, reason: "initial_backfill" });
  assert.equal(backfill.addedEvents, 2);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].batch.reason, "initial_backfill");
});

test("live capture never sends a title from a turn before enable", async (t) => {
  const { dayDir, sessionsDir, store } = await fixture(t);
  const source = [
    row("session_meta", { id: sessionId, thread_source: "user", source: "vscode" },
      "2026-10-01T11:00:00.000Z"),
    row("response_item", { type: "message", id: "u1", role: "user",
      content: [{ type: "input_text", text: "Earlier private title" }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } },
    "2026-10-01T11:00:01.000Z"),
    row("response_item", { type: "message", id: "a1", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "New answer" }] }, at)
  ].join("\n");
  await writeFile(join(dayDir, `rollout-${sessionId}.jsonl`), source);
  const state = await store.load();
  await collectCodexChanges(state, store, { sessionsDir, workspaceId,
    deviceId: "device_test12345", captureFrom: "2026-10-01T12:00:00.000Z" });
  assert.equal(state.pending[0].batch.events.length, 1);
  assert.equal(state.pending[0].batch.events[0].text, "New answer");
  assert.equal(state.pending[0].batch.coverage.gapBefore, true);
  assert.ok(!JSON.stringify(state.pending).includes("Earlier private title"));
});

test("encrypted queue stays bound to one workspace", () => {
  const state = { workspaceId: null, seen: {}, fingerprints: {}, pending: [], quarantined: [] };
  bindWorkspace(state, workspaceId);
  assert.equal(state.workspaceId, workspaceId);
  assert.throws(() => bindWorkspace(state, "b73cd68b-bd48-46ea-a2fe-b61238d23d09"),
    /another workspace/);
  const legacy = { workspaceId: undefined, seen: {}, fingerprints: {},
    pending: [{ batch: { workspaceId } }], quarantined: [] };
  bindWorkspace(legacy, workspaceId);
  assert.equal(legacy.workspaceId, workspaceId);
});

test("pause and resume set a new observation boundary", async (t) => {
  const { home } = await fixture(t);
  await setCapturePaused(home, false, "2026-10-01T12:00:00.000Z");
  await setCapturePaused(home, true, "2026-10-01T12:01:00.000Z");
  assert.equal((await readControls(home)).captureFrom, "2026-10-01T12:00:00.000Z");
  await setCapturePaused(home, false, "2026-10-01T12:02:00.000Z");
  assert.equal((await readControls(home)).captureFrom, "2026-10-01T12:02:00.000Z");
  await setCapturePaused(home, false, "2026-10-01T12:03:00.000Z");
  assert.equal((await readControls(home)).captureFrom, "2026-10-01T12:02:00.000Z");
  assert.equal(await isCaptureEpochActive(home, "2026-10-01T12:02:00.000Z"), true);
  await setCapturePaused(home, true, "2026-10-01T12:04:00.000Z");
  await setCapturePaused(home, false, "2026-10-01T12:05:00.000Z");
  assert.equal(await isCaptureEpochActive(home, "2026-10-01T12:02:00.000Z"), false);
});

test("service cycle obeys pause and writes redacted status", async (t) => {
  const { home, dayDir, sessionsDir, store } = await fixture(t);
  await writeFile(join(dayDir, `rollout-${sessionId}.jsonl`), session());
  const config = { home, sessionsDir, workspaceId, deviceId: "device_test12345",
    surface: "desktop", endpoint: null, accessToken: null };
  await setCapturePaused(home, true, "2026-10-01T12:00:00.000Z");
  const paused = await runCaptureCycle(config, store);
  assert.equal(paused.pendingBatches, 0);
  await setCapturePaused(home, false, "2026-10-01T12:00:00.000Z");
  const enabled = await runCaptureCycle(config, store);
  assert.equal(enabled.pendingBatches, 1);
  const statusText = await readFile(join(home, "status.json"), "utf8");
  assert.ok(!statusText.includes("Capture this conversation"));
  await setCapturePaused(home, true, "2026-10-01T12:01:00.000Z");
  await writeFile(join(dayDir, `rollout-${sessionId}.jsonl`), session().replace("Captured reply", "New assistant reply"));
  const pausedAgain = await runCaptureCycle(config, store);
  assert.equal(pausedAgain.pendingBatches, 1);
});

test("a pause during scanning leaves events unqueued and retriable", async (t) => {
  const { dayDir, sessionsDir, store } = await fixture(t);
  await writeFile(join(dayDir, `rollout-${sessionId}.jsonl`), session());
  const state = await store.load();
  let checks = 0;
  const result = await collectCodexChanges(state, store, { sessionsDir, workspaceId,
    deviceId: "device_test12345", captureFrom: "2026-10-01T12:00:00.000Z",
    isEnabled: async () => ++checks === 1 });
  assert.equal(result.addedEvents, 0);
  assert.equal(Object.keys(state.seen).length, 0);
});

test("uploader retains an unchanged batch for retry and removes it after success", async (t) => {
  const { dayDir, sessionsDir, store } = await fixture(t);
  await writeFile(join(dayDir, `rollout-${sessionId}.jsonl`), session());
  const state = await store.load();
  await collectCodexChanges(state, store, { sessionsDir, workspaceId,
    deviceId: "device_test12345", captureFrom: "2026-10-01T12:00:00.000Z" });
  const firstId = state.pending[0].batch.batchId;
  const requestedIds = [];
  const clock = () => new Date("2026-10-01T12:05:00.000Z");
  const retry = await uploadPending(state, store, { endpoint: "https://example.org", accessToken: "test-token", now: clock,
    fetchImpl: async (_url, options) => { requestedIds.push(options.headers["idempotency-key"]); return { ok: false, status: 503 }; } });
  assert.equal(retry.status, "retry");
  assert.equal(state.pending[0].batch.batchId, firstId);
  const done = await uploadPending(state, store, { endpoint: "https://example.org", accessToken: "test-token",
    now: () => new Date("2026-10-01T12:06:00.000Z"),
    fetchImpl: async (_url, options) => { requestedIds.push(options.headers["idempotency-key"]); return confirmed(options); } });
  assert.equal(done.uploaded, 1);
  assert.deepEqual(requestedIds, [firstId, firstId]);
  assert.equal((await store.load()).pending.length, 0);
});

test("uploader holds account mismatches and quarantines invalid batches", async (t) => {
  const { dayDir, sessionsDir, store } = await fixture(t);
  await writeFile(join(dayDir, `rollout-${sessionId}.jsonl`), session());
  const state = await store.load();
  await collectCodexChanges(state, store, { sessionsDir, workspaceId,
    deviceId: "device_test12345", captureFrom: "2026-10-01T12:00:00.000Z" });
  const blocked = await uploadPending(state, store, { endpoint: "https://example.org", accessToken: "test-token",
    now: () => new Date("2026-10-01T12:05:00.000Z"), fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(blocked.status, "account_blocked");
  assert.equal(state.pending.length, 1);
  assert.equal(state.quarantined.length, 0);
  const invalid = await uploadPending(state, store, { endpoint: "https://example.org", accessToken: "test-token",
    now: () => new Date("2026-10-01T12:07:00.000Z"), fetchImpl: async () => ({ ok: false, status: 422 }) });
  assert.equal(invalid.status, "ready");
  assert.equal(state.pending.length, 0);
  assert.equal(state.quarantined.length, 1);
});

test("pausing between queued batches prevents the next upload", async (t) => {
  const { store } = await fixture(t);
  const state = await store.load();
  state.pending = ["one", "two"].map((batchId) => ({ batch: { batchId, events: [{eventId: batchId}] }, attempts: 0 }));
  let enabled = true;
  const requested = [];
  const result = await uploadPending(state, store, {
    endpoint: "https://example.org", accessToken: "test-token",
    isEnabled: async () => enabled,
    fetchImpl: async (_url, options) => {
      requested.push(options.headers["idempotency-key"]);
      enabled = false;
      return confirmed(options);
    }
  });
  assert.equal(result.status, "paused");
  assert.deepEqual(requested, ["one"]);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].batch.batchId, "two");
});

for (const scenario of ["missing", "malformed", "wrong batch", "incomplete", "not committed"]) {
  test(`Mac HTTP success with ${scenario} receipt keeps the encrypted batch for replay`, async (t) => {
    const { dayDir, sessionsDir, store } = await fixture(t);
    await writeFile(join(dayDir, `rollout-${sessionId}.jsonl`), session());
    let state = await store.load();
    await collectCodexChanges(state, store, { sessionsDir, workspaceId,
      deviceId: "device_test12345", captureFrom: "2026-10-01T12:00:00.000Z" });
    const original = structuredClone(state.pending[0].batch);
    const result = await uploadPending(state, store, { endpoint: "https://example.org", accessToken: "test-token",
      now: () => new Date("2026-10-01T12:05:00.000Z"), fetchImpl: async () => {
        const body = { ok: true, batchId: original.batchId, result: { status: "committed", received: 2, inserted: 2, updated: 0, duplicates: 0 } };
        if (scenario === "missing") return { ok: true, status: 200, json: async () => ({}) };
        if (scenario === "malformed") return { ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } };
        if (scenario === "wrong batch") body.batchId = "different-batch";
        if (scenario === "incomplete") body.result.inserted = 1;
        if (scenario === "not committed") body.result.status = "received";
        return { ok: true, status: 200, json: async () => body };
      } });
    assert.equal(result.status, "retry");
    state = await store.load();
    assert.deepEqual(state.pending[0].batch, original);
    assert.equal(state.lastUploadAt, null);
    const replay = await uploadPending(state, store, { endpoint: "https://example.org", accessToken: "test-token",
      now: () => new Date("2026-10-01T12:06:00.000Z"), fetchImpl: async (_url, request) => {
        assert.deepEqual(JSON.parse(request.body), original);
        return { ok: true, status: 200, json: async () => ({ ok: true, batchId: original.batchId,
          result: { status: "committed", idempotentReplay: true, received: 2, inserted: 2, updated: 0, duplicates: 0 } }) };
      } });
    assert.equal(replay.uploaded, 1);
    assert.equal((await store.load()).pending.length, 0);
  });
}

test("Mac conversation grows from eight to ten turns and survives a lost receipt and restart without duplicates", async (t) => {
  const { dayDir, sessionsDir, store } = await fixture(t);
  const filename = join(dayDir, `rollout-${sessionId}.jsonl`);
  const makeSession = (count) => [
    row("session_meta", { id: sessionId, cli_version: "1.0", thread_source: "user", source: "vscode" }),
    ...Array.from({length: count}, (_, i) => row("response_item", {
      type: "message", id: `turn-${i}`, role: i % 2 ? "assistant" : "user",
      ...(i % 2 ? {phase:"final_answer"} : {internal_chat_message_metadata_passthrough:{content_item_kinds:["user.text"]}}),
      content:[{type:i % 2 ? "output_text":"input_text",text:i % 2 ? `Invented reply ${i}` : "Repeat this intentional prompt exactly."}]
    }))
  ].join("\n") + "\n";
  const options = { sessionsDir, workspaceId, deviceId: "device_test12345",
    captureFrom: "2026-10-01T12:00:00.000Z", now: () => "2026-10-01T12:05:00.000Z" };
  let state = await store.load();
  await writeFile(filename, makeSession(8));
  assert.equal((await collectCodexChanges(state, store, options)).addedEvents, 8);
  const original = structuredClone(state.pending[0].batch);
  const committedBatches = new Map();
  const cloud = new Map();
  let loseReply = true;
  const deliver = async (_url, request) => {
    const batch = JSON.parse(request.body);
    const replay = committedBatches.has(batch.batchId);
    if (!replay) {
      for (const event of batch.events) cloud.set(event.eventId, event);
      committedBatches.set(batch.batchId, structuredClone(batch));
    } else assert.deepEqual(batch, committedBatches.get(batch.batchId));
    if (loseReply) { loseReply = false; throw new Error("reply lost after server commit"); }
    return confirmed(request);
  };
  const upload = {endpoint:"https://example.org",accessToken:"invented-token",fetchImpl:deliver,
    now:()=>new Date("2026-10-01T12:05:00.000Z")};
  assert.equal((await uploadPending(state,store,upload)).status,"retry");
  state = await store.load(); // simulate a process restart using only encrypted disk state
  assert.deepEqual(state.pending[0].batch, original);
  assert.equal((await uploadPending(state,store,{...upload,now:()=>new Date("2026-10-01T12:06:00.000Z")})).uploaded,1);
  assert.equal(cloud.size,8);
  await writeFile(filename, makeSession(10));
  assert.equal((await collectCodexChanges(state,store,options)).addedEvents,2);
  await uploadPending(state,store,upload);
  state = await store.load();
  assert.equal((await collectCodexChanges(state,store,options)).addedEvents,0);
  assert.equal(state.pending.length,0);
  assert.equal(cloud.size,10);
  assert.equal(committedBatches.size,2);
  assert.deepEqual([...cloud.values()].map(({role,text})=>({role,text})), Array.from({length:10},(_,i)=>({
    role:i%2?"assistant":"user",text:i%2?`Invented reply ${i}`:"Repeat this intentional prompt exactly."
  })));
});

test("oversized Codex rows retain the source and do not advance its completed fingerprint", async(t)=>{
  const {dayDir,sessionsDir,store}=await fixture(t);
  const filename=join(dayDir,`rollout-${sessionId}.jsonl`);
  const {open}=await import("node:fs/promises");const {CODEX_MAX_ROW_BYTES}=await import("../codex.js");
  const file=await open(filename,"w");
  await file.write(session());await file.write("\n",CODEX_MAX_ROW_BYTES+4096,"utf8");await file.close();
  const state=await store.load();const options={sessionsDir,workspaceId,deviceId:"device_test12345",captureFrom:"2026-10-01T12:00:00.000Z"};
  const first=await collectCodexChanges(state,store,options);
  assert.equal(first.addedEvents,2);assert.equal(first.incompleteRows,1);
  assert.equal(state.fingerprints[filename],undefined);
  assert.match(state.lastError,/oversized log record/);
  assert.equal((await collectCodexChanges(state,store,options)).addedEvents,0);
  assert.equal(state.pending.length,1);
});
