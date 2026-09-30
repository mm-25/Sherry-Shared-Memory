import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest, reconcileDeletedArchives } from "../src/index.js";
import { BATCH_ID, MemoryR2, USER_ID, WORKSPACE_ID, configuredEnv, validBatch, validBatchV2 } from "./fixtures.mjs";

function captureRequest(payload = validBatch(), headers = {}) {
  return new Request("https://ingestion.example/v1/capture/batches", {
    method: "POST",
    headers: {
      authorization: "Bearer user-session-token",
      "content-type": "application/json",
      "idempotency-key": BATCH_ID,
      ...headers
    },
    body: JSON.stringify(payload)
  });
}

function successfulFetch(spy = {}) {
  return async (url, options = {}) => {
    if (url.endsWith("/auth/v1/user")) {
      spy.authHeaders = options.headers;
      return Response.json({ id: USER_ID });
    }
    if (url.endsWith("/rest/v1/rpc/ingest_capture_batch") || url.endsWith("/rest/v1/rpc/ingest_capture_batch_v2")) {
      spy.rpcUrl = url;
      spy.rpcHeaders = options.headers;
      spy.rpcBody = JSON.parse(options.body);
      return Response.json({ status: "committed", received: 1, inserted: 1, updated: 0, duplicates: 0 });
    }
    if (url.includes("/rest/v1/ingestion_batches?") && options.method === "PATCH") {
      spy.archiveIndex = JSON.parse(options.body);
      return Response.json(null);
    }
    if (url.includes("/rest/v1/deleted_conversations?")) return Response.json(spy.deletedConversations || []);
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test("allows permanent Firefox extension origins without relying on one profile UUID", async () => {
  const request = new Request("https://ingestion.example/v1/capture/batches", {
    method: "OPTIONS",
    headers: { origin: "moz-extension://9b4bc19a-32d7-4db6-9bea-a652b1bc63cf" }
  });
  const response = await handleRequest(request, configuredEnv(new MemoryR2()));
  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "moz-extension://9b4bc19a-32d7-4db6-9bea-a652b1bc63cf"
  );
});

test("rejects ordinary websites and malformed Firefox extension origins", async () => {
  for (const origin of ["https://example.com", "moz-extension://not-a-profile-uuid"]) {
    const request = new Request("https://ingestion.example/v1/capture/batches", {
      method: "OPTIONS",
      headers: { origin }
    });
    const response = await handleRequest(request, configuredEnv(new MemoryR2()));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
});

test("rejects unauthenticated requests before writing to R2", async () => {
  const r2 = new MemoryR2();
  const request = captureRequest(validBatch(), { authorization: "" });
  const response = await handleRequest(request, configuredEnv(r2), {
    fetch: async () => new Response(null, { status: 401 })
  });
  assert.equal(response.status, 401);
  assert.equal(r2.objects.size, 0);
});

test("an account cannot read or delete another workspace's conversation", async () => {
  const paths = [];
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (path.endsWith("/workspaces")) return Response.json([]);
    throw new Error(`Unexpected access: ${path}`);
  };
  for (const method of ["GET", "DELETE"]) {
    const response = await handleRequest(new Request(
      `https://ingestion.example/v1/conversations/87e8367e-fc17-45ba-a4d7-13295c1d765b?workspaceId=${WORKSPACE_ID}`,
      { method, headers: { authorization: "Bearer user-session-token" } }
    ), configuredEnv(new MemoryR2()), { fetch });
    assert.equal(response.status, 403);
  }
  const readback = await handleRequest(new Request(
    `https://ingestion.example/v1/conversations/87e8367e-fc17-45ba-a4d7-13295c1d765b/event-identities?workspaceId=${WORKSPACE_ID}`,
    { headers: { authorization: "Bearer user-session-token" } }
  ), configuredEnv(new MemoryR2()), { fetch });
  assert.equal(readback.status, 403);
  assert.equal(paths.some((path) => path.endsWith("/conversations")), false);
});

test("import readback returns only message identities for an owned chat", async () => {
  const chatId = "87e8367e-fc17-45ba-a4d7-13295c1d765b";
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (path.endsWith("/workspaces")) return Response.json([{ id: WORKSPACE_ID }]);
    if (path.endsWith("/conversations")) return Response.json([{ id: chatId, provider: "chatgpt", provider_conversation_id: "source-chat" }]);
    if (path.endsWith("/conversation_events")) return Response.json([{ provider_message_id: "message-one", role: "user" }]);
    throw new Error(`Unexpected access: ${path}`);
  };
  const response = await handleRequest(new Request(
    `https://ingestion.example/v1/conversations/${chatId}/event-identities?workspaceId=${WORKSPACE_ID}`,
    { headers: { authorization: "Bearer user-session-token" } }
  ), configuredEnv(new MemoryR2()), { fetch });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.events, [{ provider_message_id: "message-one", role: "user" }]);
  assert.equal(JSON.stringify(body).includes("text_content"), false);
});

test("import readback includes messages beyond the database's first 1,000 rows", async () => {
  const chatId = "87e8367e-fc17-45ba-a4d7-13295c1d765b";
  const offsets = [];
  const fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (parsed.pathname.endsWith("/workspaces")) return Response.json([{ id: WORKSPACE_ID }]);
    if (parsed.pathname.endsWith("/conversations")) return Response.json([{ id: chatId, provider: "chatgpt", provider_conversation_id: "source-chat" }]);
    if (parsed.pathname.endsWith("/conversation_events")) {
      const offset = Number(parsed.searchParams.get("offset"));
      offsets.push(offset);
      return Response.json(offset === 0
        ? Array.from({ length: 1000 }, (_, index) => ({ provider_message_id: `message-${index}`, role: "user" }))
        : [{ provider_message_id: "message-1000", role: "assistant" }]);
    }
    throw new Error(`Unexpected access: ${parsed.pathname}`);
  };
  const response = await handleRequest(new Request(
    `https://ingestion.example/v1/conversations/${chatId}/event-identities?workspaceId=${WORKSPACE_ID}`,
    { headers: { authorization: "Bearer user-session-token" } }
  ), configuredEnv(new MemoryR2()), { fetch });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.events.length, 1001);
  assert.deepEqual(offsets, [0, 1000]);
});

test("conversation deletion removes its raw events from a shared R2 archive", async () => {
  const r2 = new MemoryR2();
  const conversationId = "87e8367e-fc17-45ba-a4d7-13295c1d765b";
  const key = `${WORKSPACE_ID}/chatgpt/2026/09/14/${BATCH_ID}.json`;
  const archive = { events: [
    { conversationId: "remove-me", text: "private" },
    { conversationId: "keep-me", text: "retained" }
  ] };
  await r2.put(key, JSON.stringify(archive), { customMetadata: { sha256: "old" } });
  const mutations = [];
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (path.endsWith("/workspaces")) return Response.json([{ id: WORKSPACE_ID }]);
    if (path.endsWith("/conversations") && !options.method) return Response.json([{ id: conversationId, provider: "chatgpt", provider_conversation_id: "remove-me" }]);
    if (path.endsWith("/conversation_events")) return Response.json([{ raw_object_key: key }]);
    if (path.endsWith("/ingestion_batches") && !options.method) return Response.json([{ raw_object_key: key, provider_conversation_ids: ["remove-me", "keep-me"] }]);
    mutations.push({ path, method: options.method, body: options.body && JSON.parse(options.body) });
    return Response.json(null);
  };
  const response = await handleRequest(new Request(
    `https://ingestion.example/v1/conversations/${conversationId}?workspaceId=${WORKSPACE_ID}`,
    { method: "DELETE", headers: { authorization: "Bearer user-session-token" } }
  ), configuredEnv(r2), { fetch });
  assert.equal(response.status, 200);
  assert.deepEqual((await (await r2.get(key)).json()).events, [{ conversationId: "keep-me", text: "retained" }]);
  assert.equal(mutations.some((item) => item.path.endsWith("/deleted_conversations") && item.method === "POST"), true);
  assert.equal(mutations.some((item) => item.path.endsWith("/conversations") && item.method === "DELETE"), true);
  assert.equal(mutations.some((item) => item.path.endsWith("/ingestion_batches") && item.method === "PATCH" && item.body.payload_sha256), true);
  assert.ok(mutations.findIndex((item) => item.path.endsWith("/deleted_conversations") && item.method === "POST")
    < mutations.findIndex((item) => item.path.endsWith("/conversations") && item.method === "DELETE"));
});

test("deleting a conversation removes duplicate-only archives and leaves unrelated archives intact", async () => {
  const r2 = new MemoryR2();
  const conversationId = "87e8367e-fc17-45ba-a4d7-13295c1d765b";
  const mainKey = `${WORKSPACE_ID}/chatgpt/main.json`;
  const duplicateKey = `${WORKSPACE_ID}/chatgpt/duplicate.json`;
  const unrelatedKey = `${WORKSPACE_ID}/chatgpt/unrelated.json`;
  await r2.put(mainKey, JSON.stringify({ events: [{ conversationId: "remove-me", text: "original" }] }), {});
  await r2.put(duplicateKey, JSON.stringify({ events: [{ conversationId: "remove-me", text: "duplicate" }] }), {});
  await r2.put(unrelatedKey, JSON.stringify({ events: [{ conversationId: "other-chat", text: "keep" }] }), {});
  const mutations = [];
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (path.endsWith("/workspaces")) return Response.json([{ id: WORKSPACE_ID }]);
    if (path.endsWith("/conversations") && !options.method) return Response.json([{ id: conversationId, provider: "chatgpt", provider_conversation_id: "remove-me" }]);
    if (path.endsWith("/conversation_events")) return Response.json([{ raw_object_key: mainKey }]);
    if (path.endsWith("/ingestion_batches") && !options.method) return Response.json([
      { raw_object_key: mainKey, provider_conversation_ids: ["remove-me"] },
      { raw_object_key: duplicateKey, provider_conversation_ids: null },
      { raw_object_key: unrelatedKey, provider_conversation_ids: null }
    ]);
    mutations.push({ path, method: options.method, url });
    return Response.json(null);
  };
  const response = await handleRequest(new Request(
    `https://ingestion.example/v1/conversations/${conversationId}?workspaceId=${WORKSPACE_ID}`,
    { method: "DELETE", headers: { authorization: "Bearer user-session-token" } }
  ), configuredEnv(r2), { fetch });
  assert.equal(response.status, 200);
  assert.equal(await r2.get(mainKey), null);
  assert.equal(await r2.get(duplicateKey), null);
  assert.deepEqual((await (await r2.get(unrelatedKey)).json()).events, [{ conversationId: "other-chat", text: "keep" }]);
  assert.equal(mutations.filter((item) => item.path.endsWith("/ingestion_batches") && item.method === "DELETE").length, 2);
});

test("deletion can finish when an earlier attempt already removed the raw archive", async () => {
  const conversationId = "87e8367e-fc17-45ba-a4d7-13295c1d765b";
  const mutations = [];
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (path.endsWith("/workspaces")) return Response.json([{ id: WORKSPACE_ID }]);
    if (path.endsWith("/conversations") && !options.method) return Response.json([{ id: conversationId, provider: "chatgpt", provider_conversation_id: "remove-me" }]);
    if (path.endsWith("/conversation_events")) return Response.json([{ raw_object_key: "already-deleted.json" }]);
    if (path.endsWith("/ingestion_batches") && !options.method) return Response.json([{ raw_object_key: "already-deleted.json", provider_conversation_ids: null }]);
    mutations.push({ path, method: options.method });
    return Response.json(null);
  };
  const response = await handleRequest(new Request(
    `https://ingestion.example/v1/conversations/${conversationId}?workspaceId=${WORKSPACE_ID}`,
    { method: "DELETE", headers: { authorization: "Bearer user-session-token" } }
  ), configuredEnv(new MemoryR2()), { fetch });
  assert.equal(response.status, 200);
  assert.equal(mutations.some((item) => item.path.endsWith("/conversations") && item.method === "DELETE"), true);
  assert.equal(mutations.some((item) => item.path.endsWith("/ingestion_batches")), false);
});

test("scheduled reconciliation removes a duplicate-only archive left by an earlier deletion", async () => {
  const r2 = new MemoryR2();
  const key = `${WORKSPACE_ID}/chatgpt/duplicate-left-behind.json`;
  await r2.put(key, JSON.stringify({ events: [{ conversationId: "deleted-chat", text: "test data" }] }), {});
  const mutations = [];
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/deleted_conversations") && !options.method) return Response.json([{
      id: 17, workspace_id: WORKSPACE_ID, provider: "chatgpt", provider_conversation_id: "deleted-chat"
    }]);
    if (path.endsWith("/conversations") && !options.method) return Response.json([]);
    if (path.endsWith("/ingestion_batches") && !options.method) return Response.json([{ raw_object_key: key, provider_conversation_ids: null }]);
    mutations.push({ path, method: options.method });
    return Response.json(null);
  };
  const result = await reconcileDeletedArchives(configuredEnv(r2), fetch);
  assert.deepEqual(result, { checked: 1, reconciled: 1 });
  assert.equal(await r2.get(key), null);
  assert.equal(mutations.some((item) => item.path.endsWith("/ingestion_batches") && item.method === "DELETE"), true);
  assert.equal(mutations.some((item) => item.path.endsWith("/deleted_conversations") && item.method === "PATCH"), true);
});

test("deletion reports pending cleanup when R2 fails after the tombstone and database removal", async () => {
  const r2 = new MemoryR2();
  const conversationId = "87e8367e-fc17-45ba-a4d7-13295c1d765b";
  const key = `${WORKSPACE_ID}/chatgpt/cleanup-pending.json`;
  await r2.put(key, JSON.stringify({ events: [{ conversationId: "remove-me" }] }), {});
  r2.get = async () => { throw new Error("R2 temporarily unavailable"); };
  const mutations = [];
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (path.endsWith("/workspaces")) return Response.json([{ id: WORKSPACE_ID }]);
    if (path.endsWith("/conversations") && !options.method) return Response.json([{ id: conversationId, provider: "chatgpt", provider_conversation_id: "remove-me" }]);
    if (path.endsWith("/conversation_events")) return Response.json([{ raw_object_key: key }]);
    if (path.endsWith("/ingestion_batches") && !options.method) return Response.json([{ raw_object_key: key, provider_conversation_ids: ["remove-me"] }]);
    mutations.push({ path, method: options.method });
    return Response.json(null);
  };
  const response = await handleRequest(new Request(
    `https://ingestion.example/v1/conversations/${conversationId}?workspaceId=${WORKSPACE_ID}`,
    { method: "DELETE", headers: { authorization: "Bearer user-session-token" } }
  ), configuredEnv(r2), { fetch });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).deleted.cleanupPending, true);
  assert.deepEqual(mutations.filter((item) => item.method).map((item) => item.path.split("/").at(-1)),
    ["deleted_conversations", "conversations"]);
});

test("does not re-import a conversation the user deleted", async () => {
  const r2 = new MemoryR2();
  const spy = { deletedConversations: [{ provider_conversation_id: "conversation-123" }] };
  const response = await handleRequest(captureRequest(), configuredEnv(r2), { fetch: successfulFetch(spy) });
  assert.equal(response.status, 200);
  assert.equal(r2.objects.size, 0);
  assert.equal((await response.json()).ignoredDeletedEvents, 1);
});

test("redacts, archives, and commits a valid batch with separate public and secret keys", async () => {
  const r2 = new MemoryR2();
  const spy = {};
  const payload = validBatch();
  payload.events[0].text = "My API key: sk-ant-abcdefghijklmnopqrstuvwxyz";
  const response = await handleRequest(captureRequest(payload), configuredEnv(r2), {
    fetch: successfulFetch(spy)
  });

  assert.equal(response.status, 200);
  assert.equal(r2.objects.size, 1);
  const archived = JSON.parse([...r2.objects.values()][0].value);
  assert.equal(archived.events[0].text.includes("sk-ant-"), false);
  assert.equal(spy.authHeaders.apikey, "sb_publishable_test");
  assert.equal(spy.authHeaders.authorization, "Bearer user-session-token");
  assert.equal(spy.rpcHeaders.apikey, "sb_secret_test");
  assert.equal("authorization" in spy.rpcHeaders, false);
  assert.equal(spy.rpcBody.p_user_id, USER_ID);
  assert.equal(spy.rpcBody.p_batch_id, BATCH_ID);
  assert.equal(spy.rpcBody.p_events[0].text.includes("sk-ant-"), false);
  assert.deepEqual(spy.archiveIndex.provider_conversation_ids, [payload.events[0].conversationId]);
});

test("an archive-index failure is retryable without losing the committed raw batch", async () => {
  const r2 = new MemoryR2();
  const normalFetch = successfulFetch();
  const failingFetch = async (url, options = {}) =>
    url.includes("/rest/v1/ingestion_batches?") && options.method === "PATCH"
      ? Response.json({ error: "unavailable" }, { status: 503 })
      : normalFetch(url, options);
  const first = await handleRequest(captureRequest(), configuredEnv(r2), { fetch: failingFetch });
  assert.equal(first.status, 503);
  assert.equal(r2.objects.size, 1);
  const second = await handleRequest(captureRequest(), configuredEnv(r2), { fetch: successfulFetch() });
  assert.equal(second.status, 200);
  assert.equal(r2.objects.size, 1);
});

test("archives Capture API v2 provenance and uses the v2 metadata transaction", async () => {
  const r2 = new MemoryR2();
  const spy = {};
  const response = await handleRequest(captureRequest(validBatchV2()), configuredEnv(r2), {
    fetch: successfulFetch(spy)
  });

  assert.equal(response.status, 200);
  assert.match(spy.rpcUrl, /ingest_capture_batch_v2$/);
  assert.equal(spy.rpcBody.p_provider_family, "openai");
  assert.equal(spy.rpcBody.p_product, "chatgpt");
  assert.equal(spy.rpcBody.p_surface, "web");
  assert.equal(spy.rpcBody.p_capture_client.deviceId, "device:browser-test");
  assert.equal(spy.rpcBody.p_coverage.state, "complete_observed_range");
  const archived = JSON.parse([...r2.objects.values()][0].value);
  assert.equal(archived.ingestion.archiveVersion, 2);
  assert.equal(archived.captureClient.captureSessionId, "session:browser-test");
});

test("accepts a native v2 event without a URL and archives only safe attachment metadata", async () => {
  const r2 = new MemoryR2();
  const payload = validBatchV2({
    provider: "codex",
    providerFamily: "openai",
    product: "codex",
    surface: "cli",
    reason: "hook",
    captureClient: { type: "structured_hook", adapterVersion: "1.0.0", deviceId: "device:codex-test", os: "macos", appVersion: "1.2.3", captureSessionId: "session:codex-test" },
    events: [{ ...validBatch().events[0], provider: "codex", sourceUrl: null, sourceLocator: "codex-session:local-123", attachments: [{ name: "document", extraPrivateField: "do-not-store" }] }]
  });
  const response = await handleRequest(captureRequest(payload), configuredEnv(r2), { fetch: successfulFetch() });
  assert.equal(response.status, 200);
  const archived = JSON.parse([...r2.objects.values()][0].value);
  assert.equal(archived.events[0].sourceUrl, null);
  assert.equal(JSON.stringify(archived).includes("do-not-store"), false);
});

test("removes the R2 object when the metadata transaction is rejected", async () => {
  const r2 = new MemoryR2();
  const fetch = async (url) => {
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: USER_ID });
    if (url.includes("/rest/v1/deleted_conversations?")) return Response.json([]);
    return Response.json({ message: "database unavailable" }, { status: 503 });
  };
  const response = await handleRequest(captureRequest(), configuredEnv(r2), { fetch });
  assert.equal(response.status, 502);
  assert.equal(r2.objects.size, 0);
  assert.equal(r2.deleteCount, 1);
});

test("replays an identical batch without rewriting its immutable R2 object", async () => {
  const r2 = new MemoryR2();
  const env = configuredEnv(r2);
  const first = await handleRequest(captureRequest(), env, { fetch: successfulFetch() });
  const second = await handleRequest(captureRequest(), env, { fetch: successfulFetch() });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(r2.putCount, 1);
  assert.equal(r2.deleteCount, 0);
});

test("rejects changed content that reuses an existing batch identifier", async () => {
  const r2 = new MemoryR2();
  const env = configuredEnv(r2);
  await handleRequest(captureRequest(), env, { fetch: successfulFetch() });
  const changed = validBatch();
  changed.events[0].text = "Different content with the same batch ID";
  const response = await handleRequest(captureRequest(changed), env, { fetch: successfulFetch() });
  assert.equal(response.status, 409);
  assert.equal(r2.putCount, 1);
  assert.equal(r2.deleteCount, 0);
});

test("rejects an idempotency key that does not match the batch", async () => {
  const r2 = new MemoryR2();
  const response = await handleRequest(
    captureRequest(validBatch(), { "idempotency-key": "11e3fb2e-481d-42f4-83af-e24e763c337f" }),
    configuredEnv(r2),
    { fetch: successfulFetch() }
  );
  assert.equal(response.status, 409);
  assert.equal(r2.objects.size, 0);
});
