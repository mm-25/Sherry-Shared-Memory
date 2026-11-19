import assert from "node:assert/strict";
import test from "node:test";
import { activityFromEvents, conversationActivity, orderTranscriptEvents, transcriptCoverage } from "../src/conversation-activity.js";
import { handleRequest } from "../src/index.js";
import { MemoryR2, USER_ID, WORKSPACE_ID, configuredEnv } from "./fixtures.mjs";

test("transcript coverage does not mistake on-screen positions for missing messages", () => {
  const coverage = transcriptCoverage({ coverage_state: "complete_observed_range", gap_detected: false }, [
    { sequence: 0, role: "assistant" },
    { sequence: 2, role: "user" }
  ]);
  assert.equal(coverage.status, "observed_range");
  assert.equal(coverage.reasons.length, 0);
  assert.equal(transcriptCoverage({ coverage_state: "complete_observed_range" }, [{ sequence: 0, role: "user" }]).status, "observed_range");
  assert.equal(transcriptCoverage({ coverage_state: "gap_detected" }, []).status, "partial_or_uncertain");
});

test("historical import uses Claude's message date, not the upload date", () => {
  const conversation = { last_captured_at: "2026-09-24T14:00:00Z" };
  const activity = activityFromEvents(conversation, [
    { message_timestamp: "2024-03-11T10:00:00Z", captured_at: conversation.last_captured_at, source_locator: "historical-import:claude:a:1" },
    { message_timestamp: "2024-06-21T12:00:00Z", captured_at: conversation.last_captured_at, source_locator: "historical-import:claude:a:2" }
  ]);
  assert.deepEqual(activity, { last_activity_at: "2024-06-21T12:00:00.000Z", last_activity_basis: "source_message" });
});

test("a genuinely new live message can move an imported chat forward", () => {
  const activity = activityFromEvents({ last_captured_at: "2026-09-24T14:00:00Z" }, [
    { message_timestamp: "2024-06-21T12:00:00Z", captured_at: "2026-09-24T14:00:00Z", source_locator: "historical-import:claude:a:1" },
    { message_timestamp: null, captured_at: "2026-09-25T09:00:00Z", source_locator: "web:claude:a" }
  ]);
  assert.deepEqual(activity, { last_activity_at: "2026-09-25T09:00:00.000Z", last_activity_basis: "first_captured_message" });
});

test("repeat scans of unchanged text do not change the chat date", () => {
  const text = "A long, unchanged Gemini message that was already captured on September twenty-fourth.";
  const activity = activityFromEvents({ last_captured_at: "2026-09-27T12:00:00Z" }, [
    { id: 1, role: "assistant", text_content: text, first_captured_at: "2026-09-24T12:00:00Z", captured_at: "2026-09-24T12:00:00Z", sequence: 30 },
    { id: 2, role: "assistant", text_content: text, first_captured_at: "2026-09-27T12:00:00Z", captured_at: "2026-09-27T12:00:00Z", sequence: 14 }
  ]);
  assert.deepEqual(activity, { last_activity_at: "2026-09-24T12:00:00.000Z", last_activity_basis: "first_captured_message" });
});

test("transcript follows source time or first capture, not position resets", () => {
  const events = orderTranscriptEvents([
    { id: 2, sequence: 0, first_captured_at: "2026-09-25T10:00:00Z" },
    { id: 1, sequence: 12, first_captured_at: "2026-09-24T10:00:00Z" }
  ]);
  assert.deepEqual(events.map((event) => event.id), [1, 2]);
});

test("conversations without source dates retain a capture-date fallback", () => {
  assert.deepEqual(conversationActivity({ last_captured_at: "2026-09-24T14:00:00Z" }), {
    last_activity_at: "2026-09-24T14:00:00.000Z", last_activity_basis: "capture"
  });
});

test("conversation list orders imported chats by source activity", async () => {
  const fetch = async (url) => {
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (url.includes("/rest/v1/workspaces?")) return Response.json([{ id: WORKSPACE_ID }]);
    if (url.includes("/rest/v1/conversations?")) {
      const query = new URL(url).searchParams;
      assert.match(query.get("select"), /conversation_events\(count\)/);
      return Response.json([
        { id: "old-import", last_captured_at: "2026-09-24T14:00:00Z", conversation_events: [{ count: 4 }] },
        { id: "newer-chat", last_captured_at: "2026-09-20T14:00:00Z", conversation_events: [{ count: 2 }] }
      ]);
    }
    if (url.includes("/rest/v1/rpc/conversation_activity_rollup")) return Response.json([
      { conversation_id: "old-import", source_message_at: "2023-01-02T08:00:00Z", first_new_content_at: null },
      { conversation_id: "newer-chat", source_message_at: "2026-09-20T13:59:00Z", first_new_content_at: "2026-09-20T14:00:00Z" }
    ]);
    throw new Error(`Unexpected URL: ${url}`);
  };
  const request = new Request(`https://ingestion.example/v1/conversations?workspaceId=${WORKSPACE_ID}`, {
    headers: { authorization: "Bearer user-session-token" }
  });
  const response = await handleRequest(request, configuredEnv(new MemoryR2()), { fetch });
  assert.equal(response.status, 200);
  const { conversations } = await response.json();
  assert.deepEqual(conversations.map((item) => item.id), ["newer-chat", "old-import"]);
  assert.equal(conversations[1].last_activity_at, "2023-01-02T08:00:00.000Z");
  assert.equal(conversations[1].last_captured_at, "2026-09-24T14:00:00Z");
  assert.equal("source_activity" in conversations[1], false);
});

test("conversation list includes chats beyond the database's first 1,000 rows", async () => {
  const offsets = [];
  const fetch = async (url) => {
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (url.includes("/rest/v1/workspaces?")) return Response.json([{ id: WORKSPACE_ID }]);
    if (url.includes("/rest/v1/conversations?")) {
      const offset = Number(new URL(url).searchParams.get("offset"));
      offsets.push(offset);
      return Response.json(offset === 0
        ? Array.from({ length: 1000 }, (_, index) => ({ id: `chat-${index}`, last_captured_at: "2026-09-24T12:00:00Z" }))
        : [{ id: "chat-1000", last_captured_at: "2026-09-24T12:00:00Z" }]);
    }
    if (url.includes("/rest/v1/rpc/conversation_activity_rollup")) return Response.json([]);
    throw new Error(`Unexpected URL: ${url}`);
  };
  const response = await handleRequest(new Request(`https://ingestion.example/v1/conversations?workspaceId=${WORKSPACE_ID}`, {
    headers: { authorization: "Bearer user-session-token" }
  }), configuredEnv(new MemoryR2()), { fetch });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).conversations.length, 1001);
  assert.deepEqual(offsets, [0, 1000]);
});

test("conversation detail orders by first capture and does not invent a transcript gap", async () => {
  const chatId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const fetch = async (url) => {
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (url.includes("/rest/v1/workspaces?")) return Response.json([{ id: WORKSPACE_ID }]);
    if (url.includes("/rest/v1/conversations?")) return Response.json([{ id: chatId, coverage_state: "complete_observed_range", gap_detected: false, last_captured_at: "2026-09-27T12:00:00Z" }]);
    if (url.includes("/rest/v1/conversation_events?")) return Response.json([
      { id: 2, sequence: 2, role: "assistant", text_content: "A second message", first_captured_at: "2026-09-24T12:01:00Z" },
      { id: 1, sequence: 9, role: "user", text_content: "An earlier message", first_captured_at: "2026-09-24T12:00:00Z" }
    ]);
    throw new Error(`Unexpected URL: ${url}`);
  };
  const response = await handleRequest(new Request(`https://ingestion.example/v1/conversations/${chatId}?workspaceId=${WORKSPACE_ID}`, {
    headers: { authorization: "Bearer user-session-token" }
  }), configuredEnv(new MemoryR2()), { fetch });
  assert.equal(response.status, 200);
  const { conversation } = await response.json();
  assert.deepEqual(conversation.events.map((event) => event.id), [1, 2]);
  assert.equal(conversation.transcriptCoverage.reasons.length, 0);
  assert.equal(conversation.last_activity_at, "2026-09-24T12:01:00.000Z");
});

test("conversation detail includes messages beyond the database's first 1,000 rows", async () => {
  const chatId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const offsets = [];
  const fetch = async (url) => {
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (url.includes("/rest/v1/workspaces?")) return Response.json([{ id: WORKSPACE_ID }]);
    if (url.includes("/rest/v1/conversations?")) return Response.json([{ id: chatId, last_captured_at: "2026-09-24T12:00:00Z" }]);
    if (url.includes("/rest/v1/conversation_events?")) {
      const offset = Number(new URL(url).searchParams.get("offset"));
      offsets.push(offset);
      return Response.json(offset === 0
        ? Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, role: "user", text_content: `message-${index}`, first_captured_at: "2026-09-24T12:00:00Z" }))
        : [{ id: 1001, role: "assistant", text_content: "message-1000", first_captured_at: "2026-09-24T12:01:00Z" }]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const response = await handleRequest(new Request(`https://ingestion.example/v1/conversations/${chatId}?workspaceId=${WORKSPACE_ID}`, {
    headers: { authorization: "Bearer user-session-token" }
  }), configuredEnv(new MemoryR2()), { fetch });
  assert.equal(response.status, 200);
  const { conversation } = await response.json();
  assert.equal(conversation.events.length, 1001);
  assert.equal(conversation.events.at(-1).text_content, "message-1000");
  assert.deepEqual(offsets, [0, 1000]);
});
