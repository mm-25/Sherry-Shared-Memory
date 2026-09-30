import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret } from "../src/crypto.js";
import { handleRequest } from "../src/index.js";
import { validateSummarizerSettings } from "../src/settings.js";
import { MemoryR2, USER_ID, WORKSPACE_ID, configuredEnv } from "./fixtures.mjs";

const TEST_MASTER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

function validSettings(overrides = {}) {
  return {
    enabled: true,
    intervalMinutes: 10,
    provider: "anthropic",
    model: "claude-test-model",
    apiKey: "sk-ant-test-secret-1234",
    removeApiKey: false,
    ...overrides
  };
}

function request(method, body) {
  return new Request(`https://ingestion.example/v1/settings/summarizer?workspaceId=${WORKSPACE_ID}`, {
    method,
    headers: { authorization: "Bearer user-session-token", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

function settingsFetch(state, ownsWorkspace = true) {
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: USER_ID });
    if (url.pathname === "/rest/v1/workspaces") return Response.json(ownsWorkspace ? [{ id: WORKSPACE_ID }] : []);
    if (url.pathname === "/rest/v1/rpc/save_summarizer_configuration") {
      const payload = JSON.parse(options.body);
      if (payload.p_secret_action === "upsert") {
        state.secret = {
          provider: payload.p_provider,
          key_ciphertext: payload.p_key_ciphertext,
          key_iv: payload.p_key_iv,
          key_version: payload.p_key_version
        };
      } else if (payload.p_secret_action === "delete") {
        state.secret = null;
      }
      const configured = Boolean(state.secret);
      state.settings = {
        workspace_id: payload.p_workspace_id,
        enabled: payload.p_enabled,
        interval_minutes: payload.p_interval_minutes,
        min_new_events: payload.p_min_new_events,
        max_single_event_wait_minutes: payload.p_max_single_event_wait_minutes,
        continuity_overlap_events: payload.p_continuity_overlap_events,
        provider: payload.p_provider,
        model: payload.p_model,
        prompt_version: payload.p_prompt_version,
        api_key_configured: configured,
        api_key_hint: configured
          ? payload.p_api_key_hint || state.settings?.api_key_hint || null
          : null
      };
      return Response.json(state.settings);
    }
    if (url.pathname === "/rest/v1/summarizer_settings") {
      if ((options.method || "GET") === "GET") return Response.json(state.settings ? [state.settings] : []);
      state.settings = JSON.parse(options.body);
      return Response.json([state.settings]);
    }
    if (url.pathname === "/rest/v1/summarizer_secrets") {
      if ((options.method || "GET") === "GET") return Response.json(state.secret ? [{ workspace_id: WORKSPACE_ID, provider: state.secret.provider }] : []);
      if (options.method === "DELETE") {
        state.secret = null;
        return new Response(null, { status: 204 });
      }
      state.secret = JSON.parse(options.body);
      return new Response(null, { status: 201 });
    }
    throw new Error(`Unexpected URL: ${input}`);
  };
}

test("encrypts API keys with randomized AES-GCM ciphertext and supports later decryption", async () => {
  const first = await encryptSecret("secret-value", TEST_MASTER_KEY);
  const second = await encryptSecret("secret-value", TEST_MASTER_KEY);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.ciphertext.includes("secret-value"), false);
  assert.equal(await decryptSecret(first, TEST_MASTER_KEY), "secret-value");
});

test("validates time-only summarization settings", () => {
  assert.equal(validateSummarizerSettings(validSettings()).ok, true);
  assert.equal(validateSummarizerSettings(validSettings({ provider: "xai", model: "grok-test-model" })).ok, true);
  assert.equal(validateSummarizerSettings(validSettings({ model: "", apiKey: "" })).ok, true);
  const invalid = validateSummarizerSettings(validSettings({ intervalMinutes: 7 }));
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.errors.map((error) => error.field), ["intervalMinutes"]);
  assert.equal("minNewEvents" in validateSummarizerSettings(validSettings({ minNewEvents: 99 })).value, false);
  assert.equal(validateSummarizerSettings(validSettings({ model: "claude-sonnet" })).value.model, "claude-sonnet-5");
});

test("saves only encrypted API-key material and never returns the key", async () => {
  const state = {};
  const response = await handleRequest(request("PUT", validSettings()), configuredEnv(new MemoryR2()), { fetch: settingsFetch(state) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settings.apiKeyConfigured, true);
  assert.equal(body.settings.apiKeyHint, "ending in 1234");
  assert.equal(JSON.stringify(body).includes("sk-ant-test-secret-1234"), false);
  assert.equal(state.secret.key_ciphertext.includes("sk-ant-test-secret-1234"), false);
  assert.equal(state.secret.provider, "anthropic");
  assert.equal(
    await decryptSecret({ ciphertext: state.secret.key_ciphertext, iv: state.secret.key_iv }, TEST_MASTER_KEY),
    "sk-ant-test-secret-1234"
  );
});

test("returns settings without exposing encrypted secret fields", async () => {
  const state = {
    settings: {
      workspace_id: WORKSPACE_ID,
      enabled: true,
      interval_minutes: 10,
      min_new_events: 2,
      max_single_event_wait_minutes: 30,
      continuity_overlap_events: 2,
      provider: "anthropic",
      model: "claude-test-model",
      prompt_version: "checkpoint-v1",
      api_key_hint: "ending in 1234"
    },
    secret: { provider: "anthropic", key_ciphertext: "private-ciphertext", key_iv: "private-iv" }
  };
  const response = await handleRequest(request("GET"), configuredEnv(new MemoryR2()), { fetch: settingsFetch(state) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.settings.apiKeyConfigured, true);
  assert.equal(JSON.stringify(body).includes("private-ciphertext"), false);
  assert.equal(JSON.stringify(body).includes("private-iv"), false);
});

test("removes a saved key without deleting the remaining settings", async () => {
  const state = {
    settings: { provider: "anthropic", api_key_hint: "ending in 1234" },
    secret: { provider: "anthropic", key_ciphertext: "private-ciphertext", key_iv: "private-iv" }
  };
  const response = await handleRequest(
    request("PUT", validSettings({ apiKey: "", removeApiKey: true })),
    configuredEnv(new MemoryR2()),
    { fetch: settingsFetch(state) }
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(state.secret, null);
  assert.equal(body.settings.apiKeyConfigured, false);
  assert.equal(body.settings.apiKeyHint, null);
});

test("rejects settings access to a workspace the signed-in user does not own", async () => {
  const state = {};
  const response = await handleRequest(request("GET"), configuredEnv(new MemoryR2()), { fetch: settingsFetch(state, false) });
  assert.equal(response.status, 403);
  assert.equal(state.settings, undefined);
});

test("manual summary endpoint explains when no model key is configured", async () => {
  const state = {
    settings: {
      workspace_id: WORKSPACE_ID,
      enabled: true,
      interval_minutes: 10,
      min_new_events: 2,
      max_single_event_wait_minutes: 30,
      continuity_overlap_events: 2,
      provider: "xai",
      model: null,
      prompt_version: "checkpoint-v1",
      api_key_configured: false
    }
  };
  const response = await handleRequest(new Request(
    `https://ingestion.example/v1/summaries/run?workspaceId=${WORKSPACE_ID}`,
    {
      method: "POST",
      headers: { authorization: "Bearer user-session-token", "content-type": "application/json" },
      body: "{}"
    }
  ), configuredEnv(new MemoryR2()), { fetch: settingsFetch(state) });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error.code, "summarizer_not_configured");
});

test("manual summary endpoint rejects malformed conversation identifiers before scheduling", async () => {
  const response = await handleRequest(new Request(
    `https://ingestion.example/v1/summaries/run?workspaceId=${WORKSPACE_ID}`,
    {
      method: "POST",
      headers: { authorization: "Bearer user-session-token", "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "not-a-uuid" })
    }
  ), configuredEnv(new MemoryR2()), { fetch: settingsFetch({}) });
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.error.code, "invalid_conversation_id");
});
