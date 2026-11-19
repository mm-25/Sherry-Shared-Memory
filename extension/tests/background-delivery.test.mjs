import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import * as sync from "../src/sync-core.js";
import * as receipts from "../src/upload-receipt.js";
import * as recovery from "../src/tab-recovery.js";

const coreSource = await readFile(new URL("../src/core.js", import.meta.url), "utf8");
const backgroundSource = (await readFile(new URL("../src/background.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\n/gm, "");
const config = { enabled: true, endpoint: "https://example.test/v1/capture/batches", workspaceId: "12345678-1234-4234-8234-123456789012", accessToken: "test-token-that-is-long-enough" };
const clone = (value) => structuredClone(value);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await tick(); }
  assert.ok(predicate(), "expected background work to finish");
}
function event(index, conversationId = "test-chat") {
  return { eventId: `event-${index}`, contentHash: `hash-${index}`, provider: "gemini", conversationId, providerMessageId: `message-${index}`, sequence: index, role: index % 2 ? "assistant" : "user", text: `Invented message ${index}`, capturedAt: new Date(index * 1000).toISOString(), url: `https://gemini.google.com/app/${conversationId}` };
}
const ok = (request) => {
  const batch = JSON.parse(request.body);
  return { ok: true, status: 200, json: async () => ({ ok: true, batchId: batch.batchId,
    result: { status: "committed", received: batch.events.length, inserted: batch.events.length, updated: 0, duplicates: 0 } }) };
};

function harness({ data = { ingestionConfig: clone(config) }, fetch = async (_url, request) => ok(request), beforeSet = () => {}, settingsData = {}, queryTabs = async () => [] } = {}) {
  const events = {};
  const hook = (name) => ({ addListener(fn) { (events[name] ||= []).push(fn); } });
  const alarms = new Map();
  const area = {
    async get(keys) {
      if (typeof keys === "string") keys = [keys];
      if (Array.isArray(keys)) return clone(Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])));
      return clone({ ...keys, ...data });
    },
    async set(values) { beforeSet(values); Object.assign(data, clone(values)); },
    async remove(keys) { for (const key of keys) delete data[key]; }
  };
  const browser = {
    storage: { local: area, sync: { get: async (defaults) => clone({ ...defaults, ...settingsData }), set: async (values) => Object.assign(settingsData, clone(values)) } },
    runtime: { getManifest: () => ({ version: "test" }), onMessage: hook("message"), onMessageExternal: hook("external"), onInstalled: hook("installed"), onStartup: hook("startup") },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
    permissions: { getAll: async () => ({}), onAdded: hook("permissions") },
    tabs: { query: queryTabs, get: async () => ({}), onUpdated: hook("tabUpdated"), onActivated: hook("tabActivated"), sendMessage: async () => ({ ok: true }) },
    alarms: { create: async (name, details) => alarms.set(name, details), get: async (name) => alarms.get(name), onAlarm: hook("alarm") }
  };
  const context = vm.createContext({ ...sync, ...recovery, ...receipts, browser, crypto: webcrypto, TextEncoder, URL, console, fetch, setTimeout, clearTimeout, AbortSignal });
  vm.runInContext(coreSource, context);
  vm.runInContext(backgroundSource, context);
  return {
    data, alarms, events, core: context.SharedMemoryCaptureCore,
    async message(type, payload) {
      return new Promise((resolve) => events.message[0]({ type, payload }, {}, resolve));
    },
    async capture(events) { return this.message("CAPTURE_BATCH", { events, reason: "mutation" }); }
  };
}

test("capture during an in-flight upload is delivered without opening the popup", async () => {
  const uploads = [];
  let finishFirst;
  const h = harness({ fetch: async (_url, request) => {
    uploads.push(JSON.parse(request.body));
    if (uploads.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
    return ok(request);
  } });
  await h.capture([event(0), event(1)]);
  await until(() => finishFirst);
  await h.capture([event(2), event(3)]);
  assert.equal(h.data.uploadQueue.length, 2);
  finishFirst();
  await until(() => h.data.uploadQueue.length === 0);
  assert.deepEqual(uploads.flatMap((batch) => batch.events.map((e) => e.eventId)), ["event-0", "event-1", "event-2", "event-3"]);
  assert.equal(h.data.captureStats.totalEvents, 4);
});

test("an offline upload survives restart with the same batch ID", async () => {
  const h = harness({ fetch: async () => { throw new Error("offline"); } });
  await h.capture([event(0), event(1)]);
  await until(() => h.data.uploadQueue[0].attemptCount === 1);
  const id = h.data.uploadQueue[0].payload.batchId;
  h.data.uploadQueue[0].nextAttemptAt = 0;
  const uploaded = [];
  harness({ data: h.data, fetch: async (_url, request) => { uploaded.push(JSON.parse(request.body)); return ok(request); } });
  await until(() => h.data.uploadQueue.length === 0);
  assert.equal(uploaded[0].batchId, id);
  assert.equal(uploaded[0].events.length, 2);
  assert.equal(h.data.capturedEvents.length, 2);
});

test("more than five queued batches continue on the browser alarm", async () => {
  const queue = Array.from({ length: 7 }, (_, n) => ({ payload: sync.createCaptureBatches([event(n)], config, "mutation")[0], attemptCount: 0, nextAttemptAt: 0 }));
  const h = harness({ data: { ingestionConfig: clone(config), uploadQueue: queue } });
  await until(() => h.data.uploadQueue.length === 2);
  await tick();
  assert.equal(h.alarms.get("shared-memory-upload").periodInMinutes, 1);
  for (const listener of h.events.alarm) listener({ name: "shared-memory-upload" });
  await until(() => h.data.uploadQueue.length === 0);
});

test("a failed delivery commit does not acknowledge or strand a locally saved capture", async () => {
  let fail = true;
  const h = harness({ beforeSet: (values) => { if (fail && values.uploadQueue?.length) throw new Error("disk full"); } });
  const first = await h.capture([event(0)]);
  assert.equal(first.ok, false);
  assert.equal(h.data.capturedEvents, undefined);
  fail = false;
  assert.equal((await h.capture([event(0)])).ok, true);
  await until(() => h.data.uploadQueue.length === 0);
  assert.equal(h.data.capturedEvents.length, 1);
});

test("a late upload response cannot restore a disconnected account", async () => {
  let finish;
  const h = harness({ fetch: async (_url, request) => { await new Promise((resolve) => { finish = resolve; }); return ok(request); } });
  await h.capture([event(0)]);
  await until(() => finish);
  await h.message("CLEAR_INGESTION_CONFIG");
  finish();
  await tick(); await tick();
  assert.equal(h.data.ingestionConfig.enabled, false);
  assert.equal(h.data.ingestionConfig.accessToken, undefined);
  assert.equal(h.data.ingestionConfig.refreshToken, undefined);
  assert.equal(h.data.uploadQueue.length, 1);
  assert.equal(h.data.captureStats.pendingBatches, 1);
  assert.equal((await h.message("GET_STATUS")).settings.captureEnabled, false);
});

test("a different account cannot inherit queued uploads or old credentials", async () => {
  const h = harness({ fetch: async () => { throw new Error("offline"); } });
  await h.capture([event(0)]);
  await until(() => h.data.uploadQueue[0].attemptCount === 1);
  const result = await h.message("UPDATE_INGESTION_CONFIG", { ...config, workspaceId: "aaaaaaaa-1234-4234-8234-123456789012", accessToken: "another-test-token-long-enough" });
  assert.equal(result.ok, false);
  assert.equal(h.data.ingestionConfig.workspaceId, config.workspaceId);
  assert.equal(h.data.uploadQueue.length, 1);
});

test("the first exchange waits for the permanent chat address, then all eight messages upload", async () => {
  const uploaded = [];
  const h = harness({ fetch: async (_url, request) => { uploaded.push(JSON.parse(request.body)); return ok(request); } });
  const make = (n, conversationId) => h.core.createCapturedEvent({ ...event(n, conversationId), url: `https://gemini.google.com/app/${conversationId}`, title: "Invented chat" });
  await h.capture([make(0, "pending:new-chat"), make(1, "pending:new-chat")]);
  await tick();
  assert.equal(uploaded.length, 0);
  assert.equal(h.data.capturedEvents.length, 2);
  const result = await h.message("REKEY_CONVERSATION", { fromConversationId: "pending:new-chat", toConversationId: "permanent-chat", sourceUrl: "https://gemini.google.com/app/permanent-chat" });
  assert.equal(result.ok, true);
  await h.capture(Array.from({ length: 8 }, (_, n) => make(n, "permanent-chat")));
  await until(() => h.data.uploadQueue.length === 0);
  const messages = uploaded.flatMap((batch) => batch.events);
  assert.equal(messages.length, 8);
  assert.equal(new Set(messages.map((message) => message.eventId)).size, 8);
  assert.ok(messages.every((message) => message.conversationId === "permanent-chat"));
  assert.equal(h.data.capturedEvents.length, 8);
});

test("provisional messages are not automatically forwarded after switching accounts", async () => {
  const uploaded = [];
  const h = harness({ fetch: async (_url, request) => { uploaded.push(JSON.parse(request.body)); return ok(request); } });
  await h.capture([event(0, "pending:account-a")]);
  await h.message("CLEAR_INGESTION_CONFIG");
  await h.message("UPDATE_INGESTION_CONFIG", { ...config, workspaceId: "aaaaaaaa-1234-4234-8234-123456789012", accessToken: "different-account-token-long-enough" });
  await h.message("REKEY_CONVERSATION", { fromConversationId: "pending:account-a", toConversationId: "permanent-chat", sourceUrl: "https://gemini.google.com/app/permanent-chat" });
  await tick();
  assert.equal(uploaded.length, 0);
  assert.equal(h.data.capturedEvents.length, 1);
});

test("opted-in temporary chats can upload without ever getting a permanent address", async () => {
  const uploaded = [];
  const h = harness({ fetch: async (_url, request) => { uploaded.push(JSON.parse(request.body)); return ok(request); } });
  const result = await h.message("CAPTURE_BATCH", { events: [event(0, "pending:temporary-chat")], reason: "mutation", temporaryChat: true });
  assert.equal(result.ok, true);
  await until(() => h.data.uploadQueue.length === 0);
  assert.equal(uploaded.length, 1);
});

test("full queues reject the acknowledgement instead of silently dropping a new batch", async () => {
  const queue = Array.from({ length: 100 }, (_, n) => ({ payload: sync.createCaptureBatches([event(n)], config, "mutation")[0], attemptCount: 0, nextAttemptAt: Date.now() + 60000 }));
  const h = harness({ data: { ingestionConfig: clone(config), uploadQueue: queue } });
  const result = await h.capture([event(101)]);
  assert.equal(result.ok, false);
  assert.match(result.error, /waiting list is full/);
  assert.equal(h.data.uploadQueue.length, 100);
  assert.equal(h.data.capturedEvents, undefined);
});

test("background wake resumes durable uploads without popup or startup event", async () => {
  const payload = sync.createCaptureBatches([event(0)], config, "mutation")[0];
  const data = { ingestionConfig: clone(config), uploadQueue: [{ payload, attemptCount: 0, nextAttemptAt: 0 }] };
  const uploads = [];
  harness({ data, fetch: async (_url, request) => { uploads.push(JSON.parse(request.body)); return ok(request); } });
  await until(() => uploads.length === 1);
  await until(() => data.uploadQueue.length === 0);
});

test('a saved capture setting stays acknowledged when tab recovery fails',async()=>{
 const settingsData={captureEnabled:false};
 const h=harness({settingsData,queryTabs:async()=>{throw new Error('Tab recovery unavailable');}});
 const receipt=await h.message('UPDATE_SETTINGS',{captureEnabled:true});
 assert.equal(receipt.ok,true);assert.equal(receipt.settings.captureEnabled,true);assert.equal(settingsData.captureEnabled,true);
 const reopened=harness({settingsData});assert.equal((await reopened.message('GET_STATUS')).settings.captureEnabled,true);
});

test('the signed-in website can renew the same connection through the direct Chromium route without resending history', async () => {
  const originalQueue = [{ payload: sync.createCaptureBatches([event(0)], config, 'mutation')[0], attemptCount: 1, nextAttemptAt: Date.now() + 60000 }];
  const data = { ingestionConfig: { ...clone(config), blockedReason: 'Session expired' }, uploadQueue: clone(originalQueue), capturedEvents: [event(0), event(1)] };
  const h = harness({ data });
  const request = { type: 'UPDATE_INGESTION_CONFIG', payload: { ...config, accessToken: 'renewed-access-token-long-enough', refreshToken: 'renewed-refresh-token', expiresAt: 2000000000, uploadExisting: false } };
  const receipt = await new Promise(resolve => h.events.external[0](request, { url: 'https://shared-memory-ingestion.mufaddal-m25.workers.dev/' }, resolve));
  assert.equal(receipt.ok, true, receipt.error);
  assert.equal(data.ingestionConfig.accessToken, 'renewed-access-token-long-enough');
  assert.equal(data.ingestionConfig.refreshToken, 'renewed-refresh-token');
  assert.equal(data.ingestionConfig.blockedReason, null);
  assert.deepEqual(data.uploadQueue, originalQueue);
  assert.equal(data.capturedEvents.length, 2);
});

test('an unapproved origin cannot replace the capture connection through the direct route', async () => {
  const data = { ingestionConfig: clone(config) }, h = harness({ data });
  const request = { type: 'UPDATE_INGESTION_CONFIG', payload: { ...config, accessToken: 'unwanted-access-token-long-enough' } };
  const receipt = await new Promise(resolve => h.events.external[0](request, { url: 'https://unapproved.example/' }, resolve));
  assert.equal(receipt.ok, false);
  assert.equal(data.ingestionConfig.accessToken, config.accessToken);
});

for (const scenario of ["missing", "malformed", "wrong batch", "incomplete", "not committed"]) {
  test(`HTTP success with ${scenario} receipt retains the identical batch through restart`, async () => {
    let submitted;
    const h = harness({ fetch: async (_url, request) => {
      submitted = JSON.parse(request.body);
      const body = { ok: true, batchId: submitted.batchId, result: { status: "committed", received: 2, inserted: 2, updated: 0, duplicates: 0 } };
      if (scenario === "missing") return { ok: true, status: 200, json: async () => ({}) };
      if (scenario === "malformed") return { ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } };
      if (scenario === "wrong batch") body.batchId = "different-batch";
      if (scenario === "incomplete") body.result.inserted = 1;
      if (scenario === "not committed") body.result.status = "received";
      return { ok: true, status: 200, json: async () => body };
    } });
    await h.capture([event(0), event(1)]);
    await until(() => submitted && (h.data.uploadQueue.length === 0 || h.data.uploadQueue[0].attemptCount === 1));
    assert.equal(h.data.uploadQueue.length, 1, "unclear receipt must not discard waiting work");
    assert.deepEqual(h.data.uploadQueue[0].payload, submitted);
    assert.equal(h.data.captureStats.lastSyncAt ?? null, null);
    h.data.uploadQueue[0].nextAttemptAt = 0;
    const retried = [];
    harness({ data: h.data, fetch: async (_url, request) => {
      const batch = JSON.parse(request.body); retried.push(batch);
      return { ok: true, status: 200, json: async () => ({ ok: true, batchId: batch.batchId,
        result: { status: "committed", idempotentReplay: true, received: 2, inserted: 2, updated: 0, duplicates: 0 } }) };
    } });
    await until(() => h.data.uploadQueue.length === 0);
    assert.deepEqual(retried, [submitted]);
  });
}

test("same turn rescan does not duplicate, while an intentional identical prompt uploads twice", async () => {
  const uploaded = [];
  const h = harness({ fetch: async (_url, request) => {
    const batch = JSON.parse(request.body); uploaded.push(batch);
    return { ok: true, status: 200, json: async () => ({ ok: true, batchId: batch.batchId,
      result: { status: "committed", received: batch.events.length, inserted: batch.events.length, updated: 0, duplicates: 0 } }) };
  } });
  const text = "Please repeat this detailed explanation so that I can compare your next answer with the previous one.";
  const first = h.core.createCapturedEvent({ ...event(0), providerMessageId: null, text });
  const second = h.core.createCapturedEvent({ ...event(2), providerMessageId: null, text });
  await h.capture([first]); await until(() => h.data.uploadQueue.length === 0);
  await h.capture([first, second]); await until(() => h.data.uploadQueue.length === 0);
  await h.capture([first, second]); await tick();
  assert.equal(h.data.capturedEvents.length, 2);
  assert.deepEqual(uploaded.flatMap((batch) => batch.events.map((e) => e.eventId)), [first.eventId, second.eventId]);
});

test("a provider-local first turn waits for its real URL and joins the full conversation once",async()=>{
  const uploaded=[];const h=harness({fetch:async(_url,request)=>{uploaded.push(JSON.parse(request.body));return ok(request);}});
  const make=(n,conversationId)=>h.core.createCapturedEvent({...event(n,conversationId),provider:"chatgpt",url:`https://chatgpt.com/c/${conversationId}`});
  const local="local-chatgpt:invented-local-id";
  await h.capture([make(0,local)]);await tick();
  assert.equal(uploaded.length,0);assert.equal(h.data.capturedEvents.length,1);
  assert.equal((await h.message("REKEY_CONVERSATION",{fromConversationId:local,toConversationId:"canonical-chat",sourceUrl:"https://chatgpt.com/c/canonical-chat"})).ok,true);
  await h.capture(Array.from({length:6},(_,i)=>make(i,"canonical-chat")));
  await until(()=>h.data.uploadQueue.length===0);
  assert.equal(uploaded.flatMap(b=>b.events).length,6);
  assert.ok(uploaded.every(b=>b.events.every(e=>e.conversationId==="canonical-chat")));
  assert.equal(h.data.capturedEvents.length,6);
});

const sourceMetadata = { version: 1, titleBasis: "source", conversationIdentity: "provider", messageIdentity: "provider", timestampBasis: "observed", linksStatus: "inspected", attachmentsStatus: "not_inspected" };
const health = (supported = true) => ({ ok: true, status: 200, json: async () => supported ? { sourceMetadataVersion: 1, conversationUpdatesVersion: 1 } : {} });
const metadataOk = (request) => {
  const batch = JSON.parse(request.body);
  return { ok: true, status: 200, json: async () => ({ ok: true, batchId: batch.batchId, result: { status: "committed", received: batch.events.length, inserted: batch.events.length, updated: 0, duplicates: 0, metadataReceived: batch.conversationUpdates?.length || 0, metadataUpdated: batch.conversationUpdates?.length || 0 } }) };
};
const observation = (chatTitle = "Renamed") => ({ provider: "gemini", conversationId: "test-chat", chatTitle, capturedAt: "2026-10-30T10:00:00Z", sourceMetadata: { ...sourceMetadata, messageIdentity: "unknown", timestampBasis: "unknown", linksStatus: "unknown", attachmentsStatus: "unknown" } });
test("a received source capture permits title-only delivery without changing message stats or event copies", async () => {
  const uploads = [];
  const h = harness({ fetch: async (url, request) => { if (url.endsWith("/health")) return health(); uploads.push(JSON.parse(request.body)); return metadataOk(request); } });
  await h.capture([{ ...event(0), chatTitle: "Initial", sourceMetadata }]);
  await until(() => h.data.uploadQueue.length === 0);
  assert.equal(uploads[0].events[0].sourceMetadata.version, 1);
  const stats = clone(h.data.captureStats), events = clone(h.data.capturedEvents);
  assert.equal((await h.message("CONVERSATION_METADATA", observation())).ok, true);
  await until(() => uploads.length === 2 && h.data.uploadQueue.length === 0);
  assert.deepEqual(uploads[1].events, []);
  assert.equal(uploads[1].conversationUpdates[0].chatTitle, "Renamed");
  assert.equal(h.data.captureStats.totalEvents, stats.totalEvents);
  assert.equal(h.data.captureStats.syncedEvents, stats.syncedEvents);
  assert.equal(h.data.captureStats.lastCaptureAt, stats.lastCaptureAt);
  assert.deepEqual(h.data.capturedEvents, events);
  await h.message("CONVERSATION_METADATA", observation()); await tick(); await tick();
  assert.equal(uploads.length, 2);
});
test("legacy evidence cannot authorize a title update and unavailable capability keeps new event payloads compatible", async () => {
  const uploads = [];
  const h = harness({ fetch: async (url, request) => { if (url.endsWith("/health")) return health(false); uploads.push(JSON.parse(request.body)); return metadataOk(request); } });
  await h.capture([{ ...event(0), chatTitle: "Initial", sourceMetadata }]);
  await until(() => h.data.uploadQueue.length === 0);
  assert.equal(uploads[0].events[0].sourceMetadata, undefined);
  await h.message("CONVERSATION_METADATA", observation()); await tick(); await tick();
  assert.equal(uploads.length, 1);
  assert.equal(h.data.capturedEvents[0].sourceMetadata.version, 1);
});
test("offline title observations survive restart and capability outage without touching existing immutable batches", async () => {
  let available = true;
  const h = harness({ fetch: async (url, request) => url.endsWith("/health") ? health(available) : metadataOk(request) });
  await h.capture([{ ...event(0), chatTitle: "Initial", sourceMetadata }]);
  await until(() => h.data.uploadQueue.length === 0);
  available = false;
  await h.message("CONVERSATION_METADATA", observation()); await tick(); await tick();
  assert.equal(h.data.uploadQueue.length, 0);
  assert.equal(h.data.pendingConversationMetadata.length, 1);
  const frozen = sync.createCaptureBatches([event(2)], config, "mutation")[0];
  h.data.uploadQueue.push({ payload: frozen, attemptCount: 0, nextAttemptAt: 0 });
  const uploaded = [];
  harness({ data: h.data, fetch: async (url, request) => { if (url.endsWith("/health")) return health(); uploaded.push(JSON.parse(request.body)); return metadataOk(request); } });
  await until(() => uploaded.length === 2 && h.data.uploadQueue.length === 0);
  assert.deepEqual(uploaded[0], frozen);
  assert.equal(uploaded[1].conversationUpdates[0].chatTitle, "Renamed");
});

test("a legacy unchanged rescan establishes source evidence in a new duplicate batch before a rename", async () => {
  const original = event(0); original.chatTitle = "Old generic";
  const legacy = sync.createCaptureBatches([original], config, "mutation")[0];
  const data = { ingestionConfig: clone(config), capturedEvents: [original], uploadQueue: [{ payload: legacy, attemptCount: 0, nextAttemptAt: 0 }] };
  const uploaded = [];
  const h = harness({ data, fetch: async (url, request) => {
    if (url.endsWith("/health")) return health();
    const batch = JSON.parse(request.body); uploaded.push(batch);
    const body = await metadataOk(request).json();
    if (batch.events[0]?.sourceMetadata) { body.result.inserted = 0; body.result.duplicates = batch.events.length; }
    return { ok: true, status: 200, json: async () => body };
  } });
  await until(() => data.uploadQueue.length === 0);
  await h.capture([{ ...original, chatTitle: "Actual topic", sourceMetadata }]);
  await until(() => uploaded.length === 2 && data.uploadQueue.length === 0);
  assert.deepEqual(uploaded[0], legacy);
  assert.notEqual(uploaded[1].batchId, legacy.batchId);
  assert.equal(uploaded[1].events[0].sourceMetadata.version, 1);
  assert.equal(data.captureStats.totalEvents, 1);
  assert.equal(data.captureStats.lastCaptureAt ?? null, null, "evidence replay is not new capture activity");
  await h.capture([{ ...original, chatTitle: "Actual topic", sourceMetadata }]); await tick(); await tick();
  assert.equal(uploaded.length, 2, "successful evidence replay is not repeated");
  await h.message("CONVERSATION_METADATA", observation());
  await until(() => uploaded.length === 3 && data.uploadQueue.length === 0);
  assert.deepEqual(uploaded[2].events, []);
});

test("renaming back while an earlier title upload is in flight retains the latest observation", async () => {
  let finish, delayed = true;
  const uploaded = [];
  const h = harness({ fetch: async (url, request) => {
    if (url.endsWith("/health")) return health();
    const batch = JSON.parse(request.body); uploaded.push(batch);
    if (batch.conversationUpdates && delayed) { delayed = false; await new Promise(resolve => { finish = resolve; }); }
    return metadataOk(request);
  } });
  await h.capture([{ ...event(0), chatTitle: "Initial", sourceMetadata }]);
  await until(() => h.data.uploadQueue.length === 0);
  await h.message("CONVERSATION_METADATA", observation()); await until(() => finish);
  await h.message("CONVERSATION_METADATA", { ...observation("Initial"), capturedAt: "2026-10-30T10:01:00Z" });
  finish();
  await until(() => h.data.uploadQueue.length === 0);
  assert.deepEqual(uploaded.filter(batch => batch.conversationUpdates).map(batch => batch.conversationUpdates[0].chatTitle), ["Renamed", "Initial"]);
});

test("an explicitly requested new backfill preserves local source evidence only after capability confirmation", async () => {
  const original = { ...event(0), chatTitle: "Initial", sourceMetadata };
  const uploaded = [];
  const h = harness({ data: { ingestionConfig: clone(config), capturedEvents: [original] }, fetch: async (url, request) => {
    if (url.endsWith("/health")) return health(); uploaded.push(JSON.parse(request.body)); return metadataOk(request);
  } });
  assert.equal((await h.message("REUPLOAD_EXISTING")).ok, true);
  await until(() => uploaded.length === 1 && h.data.uploadQueue.length === 0);
  assert.deepEqual(uploaded[0].events[0].sourceMetadata, sourceMetadata);
});

test("the 51st permanent failure cannot evict the sole immutable copy of an earlier failed upload", async () => {
  const originals = Array.from({ length: 51 }, (_, index) => sync.createCaptureBatches([event(index)], config, "mutation")[0]);
  const data = { ingestionConfig: clone(config), capturedEvents: [], uploadQueue: originals.map(payload => ({ payload: clone(payload), attemptCount: 0, nextAttemptAt: 0 })) };
  const h = harness({ data, fetch: async () => ({ ok: false, status: 422, json: async () => ({ error: { message: "Invented invalid payload" } }) }) });
  for (let cycle = 0; cycle < 11; cycle++) {
    await until(() => data.uploadQueue.length <= Math.max(1, 51 - (cycle + 1) * 5));
    await tick(); await tick();
    for (const listener of h.events.alarm) listener({ name: "shared-memory-upload" });
  }
  await until(() => data.uploadQueue.length === 1 && data.uploadQueue[0].attemptCount === 1);
  assert.equal(data.quarantinedUploadBatches.length, 50);
  assert.deepEqual(data.quarantinedUploadBatches.map(item => item.payload), originals.slice(0, 50));
  assert.deepEqual(data.uploadQueue[0].payload, originals[50]);
  assert.match(data.captureStats.lastSyncError, /full/i);
  assert.equal(data.capturedEvents.length, 0, "every text copy is retained by failed/waiting payloads themselves");
});

test("an incomplete metadata receipt preserves the exact title batch across restart and pause", async () => {
  let incomplete = false;
  const settingsData = { captureEnabled: true };
  const h = harness({ settingsData, fetch: async (url, request) => {
    if (url.endsWith("/health")) return health();
    const result = metadataOk(request);
    if (!incomplete) return result;
    const body = await result.json(); delete body.result.metadataReceived;
    return { ok: true, status: 200, json: async () => body };
  } });
  await h.capture([{ ...event(0), chatTitle: "Initial", sourceMetadata }]);
  await until(() => h.data.uploadQueue.length === 0);
  incomplete = true;
  await h.message("CONVERSATION_METADATA", observation());
  await until(() => h.data.uploadQueue[0]?.attemptCount === 1);
  const frozen = clone(h.data.uploadQueue[0].payload);
  settingsData.captureEnabled = false;
  h.data.uploadQueue[0].nextAttemptAt = 0;
  const uploaded = [];
  const paused = harness({ data: h.data, settingsData, fetch: async (url, request) => {
    if (url.endsWith("/health")) return health(); uploaded.push(JSON.parse(request.body)); return metadataOk(request);
  } });
  await tick(); await tick(); await tick();
  assert.equal(uploaded.length, 0);
  assert.deepEqual(h.data.uploadQueue[0].payload, frozen);
  settingsData.captureEnabled = true;
  for (const listener of paused.events.alarm) listener({ name: "shared-memory-upload" });
  await until(() => h.data.uploadQueue.length === 0);
  assert.deepEqual(uploaded, [frozen]);
});
test("a frozen source-evidence upload waits for a currently capable server without modifying bytes", async () => {
  const payload = sync.createCaptureBatches([{ ...event(0), sourceMetadata }], config, "mutation", { capabilities: { sourceMetadataVersion: 1 } })[0];
  const data = { ingestionConfig: clone(config), uploadQueue: [{ payload: clone(payload), attemptCount: 0, nextAttemptAt: 0 }] };
  let capable = false; const uploaded = [];
  const h = harness({ data, fetch: async (url, request) => {
    if (url.endsWith("/health")) return health(capable); uploaded.push(JSON.parse(request.body)); return metadataOk(request);
  } });
  await tick(); await tick(); await tick();
  assert.equal(uploaded.length, 0); assert.deepEqual(data.uploadQueue[0].payload, payload);
  capable = true; for (const listener of h.events.alarm) listener({ name: "shared-memory-upload" });
  await until(() => data.uploadQueue.length === 0);
  assert.deepEqual(uploaded, [payload]);
});

test("ordinary disconnect retains account-bound waiting and rejected payloads for same-owner reconnection", async () => {
  const frozen = sync.createCaptureBatches([event(0)], config, "mutation")[0];
  const rejected = { batchId: "failed", provider: "gemini", payload: sync.createCaptureBatches([event(1)], config, "mutation")[0], eventCount: 1 };
  const data = { ingestionConfig: { ...clone(config), refreshToken: "private-refresh" }, uploadQueue: [{ payload: frozen, attemptCount: 0, nextAttemptAt: Date.now() + 60000 }], quarantinedUploadBatches: [rejected] };
  const uploaded = [];
  const h = harness({ data, fetch: async (_url, request) => { uploaded.push(JSON.parse(request.body)); return ok(request); } });
  await h.message("CLEAR_INGESTION_CONFIG");
  assert.equal(data.ingestionConfig.enabled, false);
  assert.equal(data.ingestionConfig.accessToken, undefined); assert.equal(data.ingestionConfig.refreshToken, undefined);
  assert.deepEqual(data.uploadQueue[0].payload, frozen); assert.deepEqual(data.quarantinedUploadBatches[0], rejected);
  const other = await h.message("UPDATE_INGESTION_CONFIG", { ...config, workspaceId: "aaaaaaaa-1234-4234-8234-123456789012" });
  assert.equal(other.ok, false); assert.deepEqual(data.uploadQueue[0].payload, frozen);
  const same = await h.message("UPDATE_INGESTION_CONFIG", { ...config, accessToken: "new-same-owner-access-token" });
  assert.equal(same.ok, true); assert.equal(data.ingestionConfig.workspaceId, config.workspaceId);
  data.uploadQueue[0].nextAttemptAt = 0;
  for (const listener of h.events.alarm) listener({ name: "shared-memory-upload" });
  await until(() => data.uploadQueue.length === 0);
  assert.deepEqual(uploaded, [frozen]); assert.deepEqual(data.quarantinedUploadBatches[0], rejected);
});

test("disconnect rejects a stale reader capture instead of silently collecting after pause", async () => {
  const h = harness(); await h.message("CLEAR_INGESTION_CONFIG");
  const receipt = await h.capture([event(0)]);
  assert.equal(receipt.ok, false); assert.match(receipt.error, /disabled/i);
  assert.equal(h.data.capturedEvents, undefined);
});

test("capability recovery establishes retained local source evidence before delivering a waiting title", async () => {
  let capable = false; const uploaded = [];
  const h = harness({ fetch: async (url, request) => {
    if (url.endsWith("/health")) return health(capable);
    const batch = JSON.parse(request.body); uploaded.push(batch);
    const body = await metadataOk(request).json();
    if (batch.events[0]?.sourceMetadata) { body.result.inserted = 0; body.result.duplicates = batch.events.length; }
    return { ok: true, status: 200, json: async () => body };
  } });
  await h.capture([{ ...event(0), chatTitle: "Initial", sourceMetadata }]);
  await until(() => h.data.uploadQueue.length === 0);
  await h.message("CONVERSATION_METADATA", observation()); await tick(); await tick();
  assert.equal(uploaded.length, 1);
  capable = true;
  for (const listener of h.events.alarm) listener({ name: "shared-memory-upload" });
  await until(() => uploaded.length === 3 && h.data.uploadQueue.length === 0);
  assert.equal(uploaded[1].events[0].sourceMetadata.version, 1);
  assert.equal(uploaded[1].events[0].eventId, uploaded[0].events[0].eventId);
  assert.equal(uploaded[1].events[0].capturedAt, uploaded[0].events[0].capturedAt);
  assert.deepEqual(uploaded[2].events, []);
  assert.equal(uploaded[2].conversationUpdates[0].chatTitle, "Renamed");
  assert.equal(h.data.captureStats.totalEvents, 1); assert.equal(h.data.captureStats.syncedEvents, 1);
});

test("unscoped local source history cannot authorize automatic evidence or title delivery to a connection", async () => {
  const uploaded = [];
  const h = harness({ data: { ingestionConfig: clone(config), capturedEvents: [{ ...event(0), chatTitle: "Initial", sourceMetadata }] },
    fetch: async (url, request) => { if (url.endsWith("/health")) return health(); uploaded.push(JSON.parse(request.body)); return metadataOk(request); } });
  const response = await h.message("CONVERSATION_METADATA", observation()); await tick(); await tick();
  assert.equal(response.result.retained, false);
  assert.equal(uploaded.length, 0);
});

test("legacy evidence enrichment retains the original event time while keeping a new title observation time", async () => {
  const original = { ...event(0), chatTitle: "Legacy topic", capturedAt: "2026-01-02T03:04:05Z", firstCapturedAt: "2026-01-02T03:04:05Z", messageTimestamp: null, links: ["https://example.test/original"], attachments: [] };
  const fresh = { ...original, capturedAt: "2026-10-30T09:59:00Z", firstCapturedAt: undefined, chatTitle: "New source title", sourceMetadata };
  const uploaded = [];
  const data = { ingestionConfig: clone(config), capturedEvents: [clone(original)], captureStats: { totalEvents: 1, lastCaptureAt: original.capturedAt, updatedEvents: 0, duplicateEvents: 0 } };
  const h = harness({ data, fetch: async (url, request) => {
    if (url.endsWith("/health")) return health();
    const batch = JSON.parse(request.body); uploaded.push(batch);
    const body = await metadataOk(request).json(); body.result.inserted = 0; body.result.duplicates = batch.events.length;
    return { ok: true, status: 200, json: async () => body };
  } });
  await h.capture([fresh]); await until(() => uploaded.length === 1 && data.uploadQueue.length === 0);
  assert.equal(data.capturedEvents[0].sourceMetadata.version, 1);
  assert.equal(data.capturedEvents[0].capturedAt, original.capturedAt);
  assert.equal(data.capturedEvents[0].firstCapturedAt, original.firstCapturedAt);
  assert.equal(data.capturedEvents[0].text, original.text);
  assert.equal(data.capturedEvents[0].messageTimestamp, original.messageTimestamp);
  assert.deepEqual(data.capturedEvents[0].links, original.links);
  assert.equal(uploaded[0].events[0].capturedAt, original.capturedAt);
  assert.equal(data.captureStats.lastCaptureAt, original.capturedAt);
  assert.equal(data.captureStats.updatedEvents, 0);
  await h.message("CONVERSATION_METADATA", observation("New source title"));
  await until(() => uploaded.length === 2 && data.uploadQueue.length === 0);
  assert.equal(uploaded[1].conversationUpdates[0].capturedAt, "2026-10-30T10:00:00Z");
});
test("an old server legacy rescan retains rich local evidence and title through restart for later capability recovery", async () => {
  const original = { ...event(0), chatTitle: "Legacy topic", capturedAt: "2026-01-02T03:04:05Z" };
  const frozen = sync.createCaptureBatches([original], config, "initial_scan")[0];
  const data = { ingestionConfig: clone(config), capturedEvents: [clone(original)], uploadQueue: [{ payload: clone(frozen), attemptCount: 0, nextAttemptAt: 0 }] };
  const firstUploads = [];
  const h = harness({ data, fetch: async (url, request) => { if (url.endsWith("/health")) return health(false); firstUploads.push(JSON.parse(request.body)); return metadataOk(request); } });
  await until(() => data.uploadQueue.length === 0);
  await h.capture([{ ...original, capturedAt: "2026-10-30T09:59:00Z", chatTitle: "New source title", sourceMetadata }]);
  const saved = await h.message("CONVERSATION_METADATA", observation("New source title")); await tick(); await tick();
  assert.equal(saved.result.retained, true);
  assert.equal(data.capturedEvents[0].sourceMetadata.version, 1);
  assert.equal(data.capturedEvents[0].capturedAt, original.capturedAt);
  assert.deepEqual(firstUploads, [frozen], "old frozen legacy payload must remain exact");
  assert.equal(data.pendingConversationMetadata.length, 1);
  const recovered = [];
  harness({ data, fetch: async (url, request) => {
    if (url.endsWith("/health")) return health(); const batch = JSON.parse(request.body); recovered.push(batch);
    const body = await metadataOk(request).json(); if (batch.events.length) { body.result.inserted = 0; body.result.duplicates = batch.events.length; }
    return { ok: true, status: 200, json: async () => body };
  } });
  await until(() => recovered.length === 2 && data.uploadQueue.length === 0);
  assert.equal(recovered[0].events[0].eventId, original.eventId);
  assert.equal(recovered[0].events[0].capturedAt, original.capturedAt);
  assert.equal(recovered[0].events[0].sourceMetadata.version, 1);
  assert.deepEqual(recovered[1].events, []);
  assert.equal(recovered[1].conversationUpdates[0].chatTitle, "New source title");
  assert.equal(recovered[1].conversationUpdates[0].capturedAt, "2026-10-30T10:00:00Z");
});
