// Explicit live diagnostic. Sends two synthetic turns to the signed-in workspace.
// Excluded from npm test; stop Sherry Desktop before running it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCaptureHome, macKeychainKey } from "../service.js";
import { readControls, writeStatus } from "../controls.js";
import { EncryptedStateStore } from "../state.js";
import { collectCodexChanges } from "../collector.js";
import { refreshConnection, WORKER_URL } from "../connection.js";
import { uploadPending } from "../uploader.js";

assert.equal(process.argv[2], "--send-test-conversation", "Pass --send-test-conversation to run the live upload.");
const home = defaultCaptureHome();
assert.equal((await readControls(home))?.paused, true, "Pause capture first.");
const lock = join(home, "service.lock");
let held;
try { held = await open(lock, "wx", 0o600); }
catch { throw new Error("Close Sherry Desktop before running the live test (service lock exists)."); }
await held.writeFile(String(process.pid));
await held.close();
let key, directory;
try {
  key = await macKeychainKey();
  const store = new EncryptedStateStore(home, key);
  const state = await store.load();
  assert.equal(state.pending.length, 0, "Existing queued conversations must be handled first.");
  const account = await refreshConnection(state, store);
  assert.ok(account, "Sign in to Sherry Desktop first.");
  directory = await mkdtemp(join(tmpdir(), "sherry-mvp-smoke-"));
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const row = (type, payload) => JSON.stringify({ type, payload, timestamp });
  const source = [
    row("session_meta", { id: sessionId, thread_source: "user", source: "vscode", cli_version: "mvp-smoke-test" }),
    row("response_item", { type: "message", id: "test-user", role: "user",
      content: [{ type: "input_text", text: "Sherry Desktop MVP connection test (synthetic)" }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } }),
    row("response_item", { type: "message", id: "test-assistant", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "Synthetic reply for validating desktop capture and upload. This is not a real conversation." }] })
  ].join("\n") + "\n";
  await writeFile(join(directory, `${sessionId}.jsonl`), source, { mode: 0o600 });
  const options = { sessionsDir: directory, workspaceId: account.workspaceId,
    deviceId: "device_desktop_mvp_smoke", captureFrom: timestamp, reason: "manual" };
  const collected = await collectCodexChanges(state, store, options);
  assert.equal(collected.addedEvents, 2);
  const replay = await collectCodexChanges(state, store, options);
  assert.equal(replay.addedEvents, 0);
  const receipts = [];
  const uploadOptions = { endpoint: WORKER_URL, accessToken: account.accessToken,
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      const body = await response.clone().json().catch(() => ({}));
      receipts.push({ status: response.status, ok: body.ok, duplicate: body.duplicate,
        error: body.error?.code || body.error, batchId: body.batchId,
        result: body.result && { status: body.result.status, received: body.result.received,
          inserted: body.result.inserted, updated: body.result.updated,
          duplicates: body.result.duplicates, idempotentReplay: body.result.idempotentReplay } });
      return response;
    } };
  const original = structuredClone(state.pending[0]);
  const result = await uploadPending(state, store, uploadOptions);
  console.log(JSON.stringify({ collected: collected.addedEvents, rescanAdded: replay.addedEvents,
    upload: result, pending: state.pending.length, lastError: state.lastError, receipts }));
  assert.equal(result.uploaded, 1, "Live ingestion did not accept the test batch.");
  assert.equal(state.pending.length, 0);
  // Replay the identical batch to verify the live server's idempotency handling.
  state.pending.push(original);
  await store.save(state);
  const retry = await uploadPending(state, store, uploadOptions);
  console.log(JSON.stringify({ replayUpload: retry, pending: state.pending.length, receipt: receipts.at(-1) }));
  assert.equal(retry.uploaded, 1);
  assert.equal(state.pending.length, 0);
  assert.equal(receipts.at(-1)?.result?.idempotentReplay, true, "Server must confirm an idempotent replay.");
  const statusPath = join(home, "status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  await writeStatus(home, { ...status, pendingBatches: 0, lastUploadAt: state.lastUploadAt,
    lastError: state.lastError, heartbeatAt: new Date().toISOString(), running: false, paused: true });
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
  key?.fill(0);
  await rm(lock, { force: true });
}
