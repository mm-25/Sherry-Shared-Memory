import assert from "node:assert/strict";
import test from "node:test";
import { getSource, listProjects, saveNote, searchMemory } from "../src/retrieval.js";
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
