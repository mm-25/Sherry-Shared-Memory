import assert from "node:assert/strict";
import test from "node:test";
import { ensureRetrievalPermission, getSensitivitySettings, updateSensitivitySettings, getSource, listProjects, saveNote, searchMemory } from "../src/retrieval.js";
import { USER_ID, WORKSPACE_ID, configuredEnv, MemoryR2 } from "./fixtures.mjs";

const env = configuredEnv(new MemoryR2());
const identity = { userId: USER_ID, workspaceId: WORKSPACE_ID, provider: "claude", scopes: ["memory:read"] };

function database(readEnabled, writeEnabled = false) {
  const paths = [];
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path.endsWith("/retrieval_connections")) return Response.json([{ read_enabled: readEnabled, write_notes_enabled: writeEnabled }]);
    throw new Error(`Unexpected database read: ${path}`);
  };
  return { fetch, paths };
}

test("a disabled provider cannot inspect a source or list projects", async () => {
  const db = database(false);
  await assert.rejects(() => getSource({ ...identity, type: "excerpt", id: "123" }, env, db.fetch), /disabled/);
  await assert.rejects(() => listProjects(identity, env, db.fetch), /disabled/);
  assert.equal(db.paths.every((path) => path.endsWith("/retrieval_connections")), true);
});

test("a token without read scope cannot inspect a source even if the provider is enabled", async () => {
  const db = database(true);
  await assert.rejects(() => getSource({ ...identity, scopes: [], type: "note", id: "123" }, env, db.fetch), /disabled/);
  assert.equal(db.paths.length, 1);
});

test("an incomplete connector token cannot read or write even when provider switches are on", async () => {
  const db = database(true, true);
  const incomplete = { ...identity, scopes: undefined };
  await assert.rejects(() => getSource({ ...incomplete, type: "note", id: "123" }, env, db.fetch), /disabled/);
  await assert.rejects(() => listProjects(incomplete, env, db.fetch), /disabled/);
  await assert.rejects(() => saveNote({ ...incomplete, title: "Test", content: "Test" }, env, db.fetch), /disabled/);
  assert.equal(db.paths.every((path) => path.endsWith("/retrieval_connections")), true);
});

test("an incomplete connector token cannot search memory", async () => {
  const paths = [];
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path.endsWith("/retrieval_connections")) return Response.json([{ read_enabled: true, write_notes_enabled: true }]);
    if (path.endsWith("/retrieval_requests")) return Response.json(null);
    throw new Error(`Unexpected database read: ${path}`);
  };
  await assert.rejects(() => searchMemory({ ...identity, scopes: undefined, query: "project" }, env, fetch), /disabled/);
  assert.equal(paths.some((path) => path.includes("search_memory_context")), false);
});

test("a read-only token cannot save notes after a provider's write setting is enabled", async () => {
  const db = database(true, true);
  await assert.rejects(() => saveNote({ ...identity, title: "Test", content: "Test" }, env, db.fetch), /disabled/);
  assert.equal(db.paths.length, 1);
});

test("search continues to deny a disabled provider before querying memory", async () => {
  const paths = [];
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path.endsWith("/retrieval_connections")) return Response.json([{ read_enabled: false }]);
    if (path.endsWith("/retrieval_requests")) return Response.json(null);
    throw new Error(`Unexpected database read: ${path}`);
  };
  await assert.rejects(() => searchMemory({ ...identity, query: "project" }, env, fetch), /disabled/);
  assert.equal(paths.some((path) => path.includes("search_memory_context")), false);
});

test("loading or reconnecting a disabled provider preserves its off switches", async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if ((options.method || "GET") !== "GET") throw new Error("An existing permission must not be rewritten");
    return Response.json([{ provider: "claude", read_enabled: false, write_notes_enabled: false }]);
  };
  const permission = await ensureRetrievalPermission({ ...identity, writeNotesEnabled: true }, env, fetch);
  assert.equal(permission.read_enabled, false);
  assert.equal(permission.write_notes_enabled, false);
  assert.equal(calls.length, 1);
});

test("a disabled sensitivity category is withheld from retrieval results and source lookup", async () => {
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/retrieval_connections")) return Response.json([{ read_enabled: true, write_notes_enabled: false }]);
    if (parsed.pathname.endsWith("/rpc/search_memory_context")) return Response.json([
      { result_type: "note", result_id: "financial-note", content: "Salary details", metadata: { tags: ["sensitivity:financial"] } },
      { result_type: "note", result_id: "health-note", content: "Allowed health detail", metadata: { tags: ["sensitivity:health"] } },
      { result_type: "note", result_id: "general-note", content: "Writing preference", metadata: { tags: [] } },
      { result_type: "excerpt", result_id: "chat-text", content: "Unlabelled chat detail" },
      { result_type: "summary", result_id: "chat-summary", content: "Unlabelled chat summary" }
    ]);
    if (parsed.pathname.endsWith("/workspace_retrieval_settings")) return Response.json([{ financial_enabled: false, health_enabled: true, personal_enabled: true }]);
    if (parsed.pathname.endsWith("/sync_cursors")) return Response.json([]);
    if (parsed.pathname.endsWith("/retrieval_requests")) return Response.json(null);
    if (parsed.pathname.endsWith("/memory_notes")) return Response.json([{ id: "financial-note", tags: ["sensitivity:financial"] }]);
    throw new Error(`Unexpected database read: ${parsed.pathname}`);
  };
  const result = await searchMemory({ ...identity, query: "details" }, env, fetch);
  assert.deepEqual(result.results.map((item) => item.result_id), ["health-note"]);
  const source = await getSource({ ...identity, type: "note", id: "financial-note" }, env, fetch);
  assert.equal(source, null);
  assert.equal(await getSource({ ...identity, type: "excerpt", id: "chat-text" }, env, fetch), null);
  assert.deepEqual(await listProjects(identity, env, fetch), []);
});

test("sensitivity settings do not pretend a missing workspace row was saved", async () => {
  const fetch = async () => Response.json([]);
  await assert.rejects(() => getSensitivitySettings(WORKSPACE_ID, env, fetch), /unavailable/);
  await assert.rejects(() => updateSensitivitySettings(WORKSPACE_ID, {
    financial_enabled: false, health_enabled: true, personal_enabled: true
  }, env, fetch), /not saved/);
});

test("mobile retrieval carries observation evidence and keeps source dates unknown", async () => {
  const event = { id: 42, message_timestamp: null, captured_at: "2026-10-02T06:00:00Z", source_locator: "android-session:test", coverage_state: "partial",
    capture_evidence: { version: 1, conversationIdentity: "local_session", messageIdentity: "local_sequence", timestampBasis: "observed", orderBasis: "session_sequence", completeness: "possibly_clipped", titleBasis: "placeholder" } };
  const fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/retrieval_connections")) return Response.json([{ read_enabled: true }]);
    if (parsed.pathname.endsWith("/workspace_retrieval_settings")) return Response.json([{ financial_enabled: true, health_enabled: true, personal_enabled: true }]);
    if (parsed.pathname.endsWith("/rpc/search_memory_context")) return Response.json([{ result_type: "excerpt", result_id: "11", source_event_id: 42, content: "A mobile excerpt", metadata: { role: "user" } }]);
    if (parsed.pathname.endsWith("/conversation_events")) {
      assert.equal(parsed.searchParams.get("workspace_id"), `eq.${WORKSPACE_ID}`);
      assert.equal(parsed.searchParams.get("id"), "in.(42)");
      return Response.json([event]);
    }
    if (parsed.pathname.endsWith("/text_chunks")) return Response.json([{ id: 11, content: "A mobile excerpt", conversation_events: event }]);
    if (parsed.pathname.endsWith("/sync_cursors")) return Response.json([{ gap_detected: true }]);
    if (parsed.pathname.endsWith("/retrieval_requests")) return Response.json(null);
    throw new Error(`Unexpected read: ${parsed.pathname}`);
  };
  const result = await searchMemory({ ...identity, query: "mobile" }, env, fetch);
  assert.equal(result.results[0].metadata.messageTimestamp, null);
  assert.equal(result.results[0].metadata.observedAt, event.captured_at);
  assert.equal(result.results[0].metadata.captureEvidence.completeness, "possibly_clipped");
  assert.match(result.instructions, /not original message dates/);
  const source = await getSource({ ...identity, type: "excerpt", id: "11" }, env, fetch);
  assert.equal(source.captureEvidence.conversationIdentity, "local_session");
  assert.ok(source.observationWarnings.some(text => text.includes("Original message date unknown")));
});
