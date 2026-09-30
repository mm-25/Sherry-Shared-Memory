import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/index.js";
import { listMemory, listSummaries } from "../src/memory-review.js";
import { MemoryR2, USER_ID, WORKSPACE_ID, configuredEnv } from "./fixtures.mjs";

function reviewFetch(calls) {
  return async (input, options = {}) => {
    const url = new URL(input);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: url.pathname, method: options.method || "GET", body });
    if (url.pathname === "/auth/v1/user") return Response.json({ id: USER_ID });
    if (url.pathname === "/rest/v1/workspaces") return Response.json([{ id: WORKSPACE_ID }]);
    if (url.pathname === "/rest/v1/checkpoints") return Response.json([]);
    if (url.pathname === "/rest/v1/memory_claims") return Response.json([]);
    if (url.pathname === "/rest/v1/rpc/list_review_conflicts") return Response.json({ total: 0, items: [] });
    if (url.pathname === "/rest/v1/summarization_jobs") return Response.json([]);
    if (url.pathname === "/rest/v1/diagnostic_events") return Response.json([]);
    if (url.pathname === "/rest/v1/ingestion_batches") return Response.json([{ created_at: "2026-09-17T18:00:00.000Z", provider: "chatgpt", received_count: 2 }]);
    if (url.pathname === "/rest/v1/conversations") return Response.json([]);
    if (url.pathname === "/rest/v1/rpc/edit_checkpoint_summary") {
      return Response.json({ checkpointId: "96e54788-360a-4522-879f-e51fc84067dd", version: 2, status: "user_edited" });
    }
    throw new Error(`Unexpected URL: ${input}`);
  };
}

function request(path, options = {}) {
  return new Request(`https://ingestion.example${path}`, {
    ...options,
    headers: { authorization: "Bearer user-session-token", ...options.headers }
  });
}

test("summary collection remains available while claim and conflict routes are retired", async () => {
  const calls = [];
  const env = configuredEnv(new MemoryR2());
  const fetch = reviewFetch(calls);
  const summaries = await handleRequest(request(`/v1/summaries?workspaceId=${WORKSPACE_ID}`), env, { fetch });
  assert.equal(summaries.status, 200);
  assert.deepEqual(await summaries.json(), { summaries: [] });
  const memories = await handleRequest(request(`/v1/memories?workspaceId=${WORKSPACE_ID}`), env, { fetch });
  assert.equal(memories.status, 410);
  assert.equal((await memories.json()).error.code, "feature_retired");
  assert.equal(calls.some((call) => call.path === "/rest/v1/memory_claims"), false);
  assert.equal(calls.some((call) => call.path === "/rest/v1/conversations"), false);
});

test("summary listing includes imported chats beyond the first page", async () => {
  const checkpoints = Array.from({ length: 101 }, (_, index) => ({ id: `checkpoint-${index}`, conversation_id: `chat-${index}`, created_at: new Date(Date.UTC(2026, 8, 25, 0, 0, 101 - index)).toISOString(), status: "active" }));
  const offsets = [];
  const fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/checkpoints")) {
      const offset = Number(url.searchParams.get("offset"));
      offsets.push(offset);
      return Response.json(checkpoints.slice(offset, offset + 100));
    }
    if (url.pathname.endsWith("/conversations")) return Response.json([]);
    if (url.pathname.endsWith("/memory_claims")) return Response.json([]);
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  const summaries = await listSummaries(WORKSPACE_ID, configuredEnv(new MemoryR2()), fetch);
  assert.equal(summaries.length, 101);
  assert.deepEqual(offsets, [0, 100]);
});

test("obvious elaborations are separated without changing saved claims or conflicts", async () => {
  const earlier = { id: "a", conversation_id: "chat-a", display_text: "User prefers short replies for project updates", status: "confirmed", observed_at: "2026-09-01T00:00:00Z" };
  const newer = { id: "b", conversation_id: "chat-b", display_text: "User prefers short replies for project updates with clear next steps", status: "provisional", observed_at: "2026-09-02T00:00:00Z" };
  const different = { id: "c", conversation_id: "chat-b", display_text: "User prefers detailed replies for project updates", status: "provisional" };
  const fetch = async (input) => {
    const path = new URL(input).pathname;
    if (path.endsWith("/memory_claims")) return Response.json([earlier, newer, different]);
    if (path.endsWith("/rpc/list_review_conflicts")) return Response.json({ total: 2, items: [
      { id: "similar", status: "unresolved", left_claim_id: "a", right_claim_id: "b" },
      { id: "different", status: "unresolved", left_claim_id: "a", right_claim_id: "c" }
    ] });
    if (path.endsWith("/conversations")) return Response.json([{ id: "chat-a", title: "Earlier chat" }, { id: "chat-b", title: "Newer chat" }]);
    if (path.endsWith("/memory_evidence") || path.endsWith("/memory_claim_reviews")) return Response.json([]);
    throw new Error(`Unexpected request: ${path}`);
  };
  const result = await listMemory(WORKSPACE_ID, configuredEnv(new MemoryR2()), fetch);
  assert.equal(result.claims.length, 3);
  assert.equal(result.similarMemories[0].id, "similar");
  assert.equal(result.conflicts[0].id, "different");
  assert.equal(result.conflicts[0].leftClaim.conversation.title, "Earlier chat");
  assert.equal(result.conflictQueue.totalCandidatePairs, 2);
});

test("similar pairs beyond the first 100 do not hide a real conflict", async () => {
  const left = { id: "a", display_text: "User prefers short replies for project updates", status: "confirmed", evidence: [] };
  const right = { id: "b", display_text: "User prefers detailed replies for project updates", status: "provisional", evidence: [] };
  const items = Array.from({ length: 110 }, (_, index) => ({
    id: `similar-${index}`, left_claim_id: "a", right_claim_id: "a",
    left_text: "User prefers short replies for project updates",
    right_text: "User prefers short replies for project updates"
  }));
  items.push({ id: "different", left_claim_id: "a", right_claim_id: "b", left_text: left.display_text, right_text: right.display_text });
  const fetch = async (input) => {
    const path = new URL(input).pathname;
    if (path.endsWith("/rpc/list_review_conflicts")) return Response.json({ total: items.length, items });
    if (path.endsWith("/memory_claims")) return Response.json([left, right]);
    if (path.endsWith("/memory_evidence") || path.endsWith("/memory_claim_reviews") || path.endsWith("/conversations")) return Response.json([]);
    throw new Error(`Unexpected request: ${path}`);
  };
  const result = await listMemory(WORKSPACE_ID, configuredEnv(new MemoryR2()), fetch);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].id, "different");
  assert.equal(result.similarMemoryCount, 110);
  assert.equal(result.conflictQueue.loadedCandidatePairs, 111);
  assert.equal(result.conflictQueue.actionableCandidatePairs, 1);
});

test("memory evidence and review history are fetched in bounded batches", async () => {
  const claims = Array.from({ length: 121 }, (_, index) => ({ id: `claim-${index}`, status: "provisional" }));
  const batchSizes = [];
  const fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/rpc/list_review_conflicts")) return Response.json({ total: 0, items: [] });
    if (url.pathname.endsWith("/memory_claims")) return Response.json(claims);
    if (url.pathname.endsWith("/memory_evidence") || url.pathname.endsWith("/memory_claim_reviews")) {
      const ids = url.searchParams.get("memory_claim_id")?.slice(4, -1).split(",") || [];
      batchSizes.push(ids.length);
      return Response.json([]);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  const result = await listMemory(WORKSPACE_ID, configuredEnv(new MemoryR2()), fetch);
  assert.equal(result.claims.length, 121);
  assert.deepEqual(batchSizes.sort((a, b) => a - b), [1, 1, 60, 60, 60, 60]);
});

test("summary edits are bounded, validated, and delegated to the atomic RPC", async () => {
  const calls = [];
  const checkpointId = "96e54788-360a-4522-879f-e51fc84067dd";
  const response = await handleRequest(request(
    `/v1/summaries/${checkpointId}?workspaceId=${WORKSPACE_ID}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summaryText: "A user-corrected summary." })
    }
  ), configuredEnv(new MemoryR2()), { fetch: reviewFetch(calls) });
  assert.equal(response.status, 200);
  const rpc = calls.find((call) => call.path.endsWith("/rpc/edit_checkpoint_summary"));
  assert.equal(rpc.body.p_summary_text, "A user-corrected summary.");
  assert.equal(rpc.body.p_actor_user_id, USER_ID);
});

test("diagnostics status reports health without exposing stored conversation content", async () => {
  const calls = [];
  const response = await handleRequest(
    request(`/v1/diagnostics/status?workspaceId=${WORKSPACE_ID}`),
    configuredEnv(new MemoryR2()),
    { fetch: reviewFetch(calls) }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "healthy");
  assert.equal(body.protections.unchangedFailedInputBlocked, true);
  assert.equal(body.latestCloudCaptureAt, "2026-09-17T18:00:00.000Z");
  assert.equal(body.stages.length, 5);
  assert.deepEqual(body.failures, []);
  const ingestionCall = calls.find((call) => call.path === "/rest/v1/ingestion_batches");
  assert.ok(ingestionCall);
});

test("diagnostics status preserves available live checks when one source fails", async () => {
  const calls = [];
  const baseFetch = reviewFetch(calls);
  const fetch = async (input, options) => {
    const url = new URL(input);
    if (url.pathname === "/rest/v1/diagnostic_events") throw new Error("schema cache unavailable");
    return baseFetch(input, options);
  };
  const response = await handleRequest(
    request(`/v1/diagnostics/status?workspaceId=${WORKSPACE_ID}`),
    configuredEnv(new MemoryR2()),
    { fetch }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "degraded");
  assert.equal(body.stages.length, 5);
  assert.equal(body.stages.find((stage) => stage.id === "capture").status, "ready");
  assert.equal(body.alerts[0].id, "diagnostics-partial");
  assert.match(body.alerts[0].message, /diagnostic events/);
});

test("a saved summary's sanitization notice does not mark a healthy pipeline as degraded", async () => {
  const calls = [];
  const baseFetch = reviewFetch(calls);
  const fetch = async (input, options) => {
    if (new URL(input).pathname === "/rest/v1/diagnostic_events") {
      return Response.json([{ stage: "summarization_output_sanitized", status: "warning", detail: {}, created_at: "2026-09-17T18:05:00.000Z" }]);
    }
    return baseFetch(input, options);
  };
  const response = await handleRequest(
    request(`/v1/diagnostics/status?workspaceId=${WORKSPACE_ID}`),
    configuredEnv(new MemoryR2()),
    { fetch }
  );
  const body = await response.json();
  assert.equal(body.status, "healthy");
  assert.equal(body.stages.find((stage) => stage.id === "summarize").status, "ready");
  assert.equal(body.alerts.some((alert) => alert.id === "summarization-sanitized"), false);
});

test("claim reviews and conflict resolutions are retired before database mutation", async () => {
  const calls = [];
  const id = "96e54788-360a-4522-879f-e51fc84067dd";
  const env = configuredEnv(new MemoryR2());
  const fetch = reviewFetch(calls);
  const review = await handleRequest(request(
    `/v1/memories/${id}/review?workspaceId=${WORKSPACE_ID}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "always" }) }
  ), env, { fetch });
  assert.equal(review.status, 410);
  const conflict = await handleRequest(request(
    `/v1/conflicts/${id}/resolve?workspaceId=${WORKSPACE_ID}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution: "erase_both" }) }
  ), env, { fetch });
  assert.equal(conflict.status, 410);
  assert.equal(calls.some((call) => call.path.includes("/rpc/review_memory_claim")), false);
  assert.equal(calls.some((call) => call.path.includes("/rpc/resolve_memory_conflict")), false);
});
