import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardMetrics, handleRequest } from "../src/index.js";
import { MemoryR2, USER_ID, WORKSPACE_ID, configuredEnv } from "./fixtures.mjs";

const conversations = [
  { id: "conversation-1", provider: "chatgpt", product: "chatgpt", primary_surface: "web", conversation_events: [{ count: 12 }] },
  { id: "conversation-2", provider: "chatgpt", product: "chatgpt", primary_surface: "web", conversation_events: [{ count: 8 }] },
  { id: "conversation-3", provider: "claude", product: "claude", primary_surface: "desktop", conversation_events: [{ count: 6 }] }
];

const checkpoints = [
  { id: "summary-1", conversation_id: "conversation-1", topics: ["Design", "Research"] },
  { id: "summary-2", conversation_id: "conversation-2", topics: ["Design"] },
  { id: "summary-3", conversation_id: "conversation-3", topics: ["Writing"] }
];

const retrievalRequests = [
  { provider: "chatgpt", result_refs: [{ type: "claim", id: "claim-1" }, { type: "claim", id: "claim-2" }] },
  { provider: "claude", result_refs: [{ type: "claim", id: "claim-1" }, { type: "excerpt", id: "chunk-1" }] }
];

test("dashboard metrics are derived from stored activity without invented values", () => {
  const result = buildDashboardMetrics({
    conversations,
    checkpoints,
    retrievalRequests,
    notes: [],
    textChunks: [{ id: "chunk-1", conversation_id: "conversation-3", source_event_id: 19, content: "A concrete research insight.", conversations: { id: "conversation-3", title: "Research notes", provider: "claude" } }]
  });

  assert.equal(result.chats.total, 3);
  assert.equal(result.chats.totalMessages, 26);
  assert.deepEqual(result.chats.byTool[0], { tool: "chatgpt", count: 2 });
  assert.deepEqual(result.messagesByTool, [
    { tool: "chatgpt", count: 20 },
    { tool: "claude", count: 6 }
  ]);
  assert.deepEqual(result.platformToolPairs[0], { platform: "web", tool: "chatgpt", count: 2 });
  assert.deepEqual(result.useCases[0], { name: "Design", count: 2, tools: [{ tool: "chatgpt", count: 2 }] });
  assert.equal(result.retrieval.total, 2);
  assert.deepEqual(result.retrieval.byTool, [
    { tool: "chatgpt", count: 1 },
    { tool: "claude", count: 1 }
  ]);
  assert.equal(result.retrieval.mostUsedMemories.some((item) => item.type === "claim"), false);
  assert.deepEqual(result.retrieval.mostUsedMemories.find((item) => item.type === "excerpt"), {
    id: "chunk-1",
    type: "excerpt",
    count: 1,
    label: "A concrete research insight.",
    conversationId: "conversation-3",
    sourceTitle: "Research notes",
    sourceProvider: "claude",
    excerpt: "A concrete research insight.",
    sourceEventId: 19
  });
  assert.deepEqual(result.summaryCoverage, { summarizedChats: 3, capturedChats: 3 });
  assert.equal(result.artifacts.indexed, false);
  assert.equal(result.artifacts.total, null);
});

test("dashboard route returns the authenticated workspace's live aggregates", async () => {
  const calls = [];
  const fetch = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: USER_ID });
    if (url.pathname === "/rest/v1/workspaces") return Response.json([{ id: WORKSPACE_ID }]);
    if (url.pathname === "/rest/v1/conversations") return Response.json(conversations);
    if (url.pathname === "/rest/v1/checkpoints") return Response.json(checkpoints);
    if (url.pathname === "/rest/v1/retrieval_requests") return Response.json(retrievalRequests);
    if (url.pathname === "/rest/v1/memory_notes") return Response.json([]);
    if (url.pathname === "/rest/v1/text_chunks") return Response.json([]);
    throw new Error(`Unexpected URL: ${input}`);
  };
  const request = new Request(`https://ingestion.example/v1/dashboard?workspaceId=${WORKSPACE_ID}`, {
    headers: { authorization: "Bearer user-session-token" }
  });

  const response = await handleRequest(request, configuredEnv(new MemoryR2()), { fetch });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.chats.total, 3);
  assert.equal(body.retrieval.mostUsedMemories[0].type, "excerpt");
  assert.equal(calls.some((call) => call.pathname === "/rest/v1/memory_claims"), false);
  assert.equal(calls.some((call) => call.pathname === "/rest/v1/retrieval_requests" && call.searchParams.get("provider") === "neq.web_test"), true);
  assert.equal(calls.some((call) => call.pathname === "/rest/v1/text_chunks" && call.searchParams.get("id") === "in.(chunk-1)"), true);
});
