import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/index.js";
import { processAccountDeletion } from "../src/account-deletion.js";
import { configuredEnv, MemoryR2, USER_ID, WORKSPACE_ID } from "./fixtures.mjs";

const job = {
  id: "eac0abb6-6703-4fc4-a2df-df2eb9aefcea",
  user_id: USER_ID,
  workspace_id: WORKSPACE_ID,
  auth_deleted_at: null,
  completed_at: null,
  expires_at: "2026-11-01T00:00:00.000Z",
  attempt_count: 0
};

function memoryNamespace(values = [], shape = "kv") {
  const keys = new Set(values);
  return {
    keys,
    async list({ prefix, limit }) {
      const matching = [...keys].filter((key) => key.startsWith(prefix)).slice(0, limit);
      return shape === "r2"
        ? { objects: matching.map((key) => ({ key })), truncated: matching.length === limit }
        : { keys: matching.map((name) => ({ name })), list_complete: matching.length < limit };
    },
    async delete(name) { keys.delete(name); }
  };
}

test("account cleanup removes only its raw archives and AI grants before the Auth user", async () => {
  const raw = memoryNamespace([`${WORKSPACE_ID}/chatgpt/a.json`, "another-workspace/chatgpt/b.json"], "r2");
  const oauth = memoryNamespace([`grant:${USER_ID}:one`, `token:${USER_ID}:one:two`, "grant:other-user:keep"]);
  const calls = [];
  const env = { ...configuredEnv(raw), OAUTH_KV: oauth };
  const fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method });
    if (url.includes("/account_deletion_jobs?")) return new Response(null, { status: 204 });
    if (url.includes("/auth/v1/admin/users/")) {
      assert.equal(raw.keys.has(`${WORKSPACE_ID}/chatgpt/a.json`), false);
      assert.equal(oauth.keys.has(`token:${USER_ID}:one:two`), false);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const result = await processAccountDeletion(job, env, fetch);
  assert.equal(result.complete, true);
  assert.equal(raw.keys.has("another-workspace/chatgpt/b.json"), true);
  assert.equal(oauth.keys.has("grant:other-user:keep"), true);
  assert.equal(calls.filter(({ url }) => url.includes("/auth/v1/admin/users/")).length, 1);
});

test("failed raw cleanup leaves Auth in place so a retry can finish", async () => {
  const raw = memoryNamespace([`${WORKSPACE_ID}/chatgpt/a.json`], "r2");
  raw.delete = async () => { throw new Error("R2 temporarily unavailable"); };
  const oauth = memoryNamespace([`grant:${USER_ID}:one`]);
  const env = { ...configuredEnv(raw), OAUTH_KV: oauth };
  let authDeleted = false;
  let savedError = null;
  const fetch = async (url, options = {}) => {
    if (url.includes("/auth/v1/admin/users/")) authDeleted = true;
    if (url.includes("/account_deletion_jobs?")) savedError = JSON.parse(options.body).last_error;
    return new Response(null, { status: 204 });
  };
  await assert.rejects(() => processAccountDeletion(job, env, fetch), /R2 temporarily unavailable/);
  assert.equal(authDeleted, false);
  assert.equal(raw.keys.size, 1);
  assert.equal(oauth.keys.size, 1);
  assert.equal(savedError, "raw_archive_cleanup_failed");
});

test("connector cleanup retries a temporary rate limit before removing Auth", async () => {
  const raw = memoryNamespace([], "r2");
  const oauth = memoryNamespace([`grant:${USER_ID}:one`]);
  const originalDelete = oauth.delete;
  let attempts = 0;
  oauth.delete = async (name) => {
    attempts += 1;
    if (attempts === 1) throw new Error("KV DELETE failed: 429 Too Many Requests");
    await originalDelete(name);
  };
  let authDeleted = false;
  const fetch = async (url) => {
    if (url.includes("/auth/v1/admin/users/")) authDeleted = true;
    return new Response(null, { status: 204 });
  };
  const result = await processAccountDeletion(job, { ...configuredEnv(raw), OAUTH_KV: oauth }, fetch);
  assert.equal(result.complete, true);
  assert.equal(attempts, 2);
  assert.equal(authDeleted, true);
  assert.equal(oauth.keys.size, 0);
});

test("account deletion requires the owner and exact typed confirmation", async () => {
  const env = configuredEnv(new MemoryR2());
  const paths = [];
  const fetch = async (url) => {
    paths.push(url);
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (url.includes("/workspaces?")) return Response.json([{ id: WORKSPACE_ID }]);
    throw new Error(`Unexpected URL ${url}`);
  };
  const request = (confirmation) => new Request(`https://ingestion.example/v1/account?workspaceId=${WORKSPACE_ID}`, {
    method: "DELETE",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ confirmation })
  });
  const response = await handleRequest(request("DELETE"), env, { fetch });
  assert.equal(response.status, 422);
  assert.equal(paths.some((path) => path.includes("request_account_deletion")), false);

  const denied = await handleRequest(request("DELETE MY SHERRY ACCOUNT"), env, {
    fetch: async (url) => url.endsWith("/auth/v1/user") ? Response.json({ id: USER_ID }) : Response.json([])
  });
  assert.equal(denied.status, 403);
});

test("accepted account deletion starts cleanup only after the owner check", async () => {
  const env = { ...configuredEnv(memoryNamespace([], "r2")), OAUTH_KV: memoryNamespace() };
  const paths = [];
  const background = [];
  const fetch = async (url, options = {}) => {
    paths.push(url);
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (url.includes("/workspaces?")) return Response.json([{ id: WORKSPACE_ID }]);
    if (url.endsWith("/rpc/request_account_deletion")) {
      assert.deepEqual(JSON.parse(options.body), { p_user_id: USER_ID, p_workspace_id: WORKSPACE_ID });
      return Response.json(job);
    }
    if (url.includes("/auth/v1/admin/users/")) return new Response(null, { status: 204 });
    if (url.includes("/account_deletion_jobs?")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected URL ${url}`);
  };
  const response = await handleRequest(new Request(`https://ingestion.example/v1/account?workspaceId=${WORKSPACE_ID}`, {
    method: "DELETE", headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE MY SHERRY ACCOUNT" })
  }), env, { fetch, ctx: { waitUntil(promise) { background.push(promise); } } });
  assert.equal(response.status, 202);
  await Promise.all(background);
  assert.ok(paths.findIndex((path) => path.includes("/workspaces?")) < paths.findIndex((path) => path.includes("request_account_deletion")));
  assert.equal(paths.some((path) => path.includes("/auth/v1/admin/users/")), true);
});

test("a repeated account deletion request reports the existing job after the workspace is gone", async () => {
  const paths = [];
  const response = await handleRequest(new Request(`https://ingestion.example/v1/account?workspaceId=${WORKSPACE_ID}`, {
    method: "DELETE", headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE MY SHERRY ACCOUNT" })
  }), configuredEnv(new MemoryR2()), {
    fetch: async (url) => {
      paths.push(url);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
      if (url.includes("/workspaces?")) return Response.json([]);
      if (url.includes("/account_deletion_jobs?")) return Response.json([{ id: job.id }]);
      throw new Error(`Unexpected URL ${url}`);
    }
  });
  assert.equal(response.status, 202);
  assert.equal(paths.some((path) => path.includes("request_account_deletion")), false);
});
