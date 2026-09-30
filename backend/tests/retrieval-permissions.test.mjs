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
