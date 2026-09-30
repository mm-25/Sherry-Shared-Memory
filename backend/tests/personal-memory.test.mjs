import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/index.js";
import { MemoryR2, USER_ID, WORKSPACE_ID, configuredEnv } from "./fixtures.mjs";

const ENTRY_ID = "96e54788-360a-4522-879f-e51fc84067dd";
const CATEGORY_ID = "a04b4142-1b1d-4ef4-b354-688242119c50";

function request(path, options = {}) {
  return new Request(`https://ingestion.example${path}`, {
    ...options,
    headers: { authorization: "Bearer user-session-token", ...options.headers }
  });
}

function memoryFetch(calls, rows = []) {
  return async (input, options = {}) => {
    const url = new URL(input);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: url.pathname, search: url.search, method: options.method || "GET", body });
    if (url.pathname === "/auth/v1/user") return Response.json({ id: USER_ID });
    if (url.pathname === "/rest/v1/workspaces") return Response.json([{ id: WORKSPACE_ID }]);
    if (url.pathname === "/rest/v1/memory_notes") {
      if ((options.method || "GET") === "POST") {
        return Response.json([{ id: ENTRY_ID, ...body, created_at: "2026-09-24T12:00:00.000Z", updated_at: "2026-09-24T12:00:00.000Z" }]);
      }
      return Response.json(rows);
    }
    throw new Error(`Unexpected URL: ${input}`);
  };
}

test("personal memory returns only Sherry-owned category and entry records", async () => {
  const calls = [];
  const rows = [
    {
      id: CATEGORY_ID,
      title: "Travel",
      content: "Travel preferences",
      tags: ["sherry:personal", "sherry:category"],
      created_at: "2026-09-24T10:00:00.000Z",
      updated_at: "2026-09-24T10:00:00.000Z"
    },
    {
      id: ENTRY_ID,
      title: "Seat preference",
      content: "Window seat",
      tags: ["sherry:personal", "sherry:entry", "category:Travel", "field:custom%3Aseat", "custom:true"],
      created_at: "2026-09-24T11:00:00.000Z",
      updated_at: "2026-09-24T11:00:00.000Z"
    },
    { id: "unrelated", title: "Other note", content: "Not personal memory", tags: [] }
  ];
  const response = await handleRequest(
    request(`/v1/personal-memory?workspaceId=${WORKSPACE_ID}`),
    configuredEnv(new MemoryR2()),
    { fetch: memoryFetch(calls, rows) }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.categories.length, 1);
  assert.equal(body.categories[0].name, "Travel");
  assert.equal(body.entries.length, 1);
  assert.deepEqual(body.entries[0], {
    id: ENTRY_ID,
    kind: "entry",
    category: "Travel",
    fieldKey: "custom:seat",
    label: "Seat preference",
    content: "Window seat",
    isCustom: true,
    createdAt: "2026-09-24T11:00:00.000Z",
    updatedAt: "2026-09-24T11:00:00.000Z"
  });
});

test("creating a personal memory entry persists a user-authored tagged note", async () => {
  const calls = [];
  const response = await handleRequest(request(
    `/v1/personal-memory?workspaceId=${WORKSPACE_ID}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "entry", category: "Basic information", fieldKey: "default:name", label: "Name", content: "Mufaddal", isCustom: false })
    }
  ), configuredEnv(new MemoryR2()), { fetch: memoryFetch(calls) });
  assert.equal(response.status, 201);
  const insert = calls.find((call) => call.path === "/rest/v1/memory_notes" && call.method === "POST");
  assert.equal(insert.body.authority, "user_authored");
  assert.deepEqual(insert.body.tags, ["sherry:personal", "sherry:entry", "category:Basic%20information", "field:default%3Aname", "custom:false"]);
});

test("invalid personal memory payloads are rejected before database mutation", async () => {
  const calls = [];
  const response = await handleRequest(request(
    `/v1/personal-memory?workspaceId=${WORKSPACE_ID}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "entry", content: "Missing metadata" }) }
  ), configuredEnv(new MemoryR2()), { fetch: memoryFetch(calls) });
  assert.equal(response.status, 422);
  assert.equal(calls.some((call) => call.path === "/rest/v1/memory_notes"), false);
});
