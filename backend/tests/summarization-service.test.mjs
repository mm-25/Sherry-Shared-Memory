import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecret } from "../src/crypto.js";
import { SummarizerGatewayError } from "../src/summarizer-gateway.js";
import { executeSummarizationJob, runSummarizationCycle, summarizationLimits } from "../src/summarization-service.js";
import { MemoryR2, WORKSPACE_ID, configuredEnv } from "./fixtures.mjs";

const NOW = new Date("2026-09-15T14:30:00.000Z");
const CONVERSATION_ID = "5484c160-6605-4b00-a14d-9dfde9b1016c";
const JOB_ID = "aa21968b-9c30-4724-b78b-c15f3f14c269";

const events = [
  { id: 10, conversation_id: CONVERSATION_ID, role: "user", text_content: "I prefer concise design feedback.", revision: 1, captured_at: "2026-09-15T14:00:00.000Z", last_captured_at: "2026-09-15T14:00:00.000Z" },
  { id: 11, conversation_id: CONVERSATION_ID, role: "assistant", text_content: "Understood.", revision: 1, captured_at: "2026-09-15T14:01:00.000Z", last_captured_at: "2026-09-15T14:01:00.000Z" }
];

const settings = {
  workspace_id: WORKSPACE_ID,
  enabled: true,
  interval_minutes: 10,
  min_new_events: 2,
  max_single_event_wait_minutes: 30,
  continuity_overlap_events: 2,
  provider: "xai",
  model: "grok-test",
  prompt_version: "checkpoint-v1",
  api_key_configured: true,
  last_scheduled_at: null,
  updated_at: "2026-09-15T13:00:00.000Z"
};

const gatewayOutput = {
  summary: "The user prefers concise design feedback.",
  topics: ["Design feedback"],
  keyDecisions: [],
  openThreads: []
};

async function serviceHarness({ failure = null, terminalFailure = null, settingsOverride = {}, sourceEvents = events } = {}) {
  const env = configuredEnv(new MemoryR2());
  const encrypted = await encryptSecret("xai-test-secret", env.SETTINGS_ENCRYPTION_KEY);
  const calls = [];
  const job = {
    id: JOB_ID,
    workspace_id: WORKSPACE_ID,
    conversation_id: CONVERSATION_ID,
    reason: "manual",
    provider: "xai",
    model: "grok-test",
    prompt_version: "checkpoint-v1",
    new_event_ids: [10, 11],
    overlap_event_ids: [],
    event_revisions: { "10": 1, "11": 1 }
  };
  const fetch = async (input, options = {}) => {
    const url = new URL(input);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: url.pathname, search: url.search, method: options.method || "GET", body });
    if (url.pathname.endsWith("/summarizer_settings")) return Response.json([{ ...settings, ...settingsOverride }]);
    if (url.pathname.endsWith("/conversations")) return Response.json([{ id: CONVERSATION_ID, provider: "chatgpt", title: "Memory Test", canonical_chat_url: "https://chatgpt.com/c/test" }]);
    if (url.pathname.endsWith("/conversation_events")) return Response.json(sourceEvents);
    if (url.pathname.endsWith("/checkpoints")) return Response.json([]);
    if (url.pathname.endsWith("/summarization_jobs")) return Response.json(terminalFailure ? [terminalFailure] : []);
    if (url.pathname.endsWith("/diagnostic_events")) return new Response(null, { status: 201 });
    if (url.pathname.endsWith("/summarizer_secrets")) {
      return Response.json([{ provider: "xai", key_ciphertext: encrypted.ciphertext, key_iv: encrypted.iv, key_version: 1 }]);
    }
    if (url.pathname.endsWith("/rpc/enqueue_summarization_job")) return Response.json({ created: true, jobId: JOB_ID });
    if (url.pathname.endsWith("/rpc/claim_summarization_job")) return Response.json(job);
    if (url.pathname.endsWith("/rpc/complete_summarization_job")) {
      return Response.json({ completed: true, checkpointId: "96e54788-360a-4522-879f-e51fc84067dd", version: 1, claimCount: 0 });
    }
    if (url.pathname.endsWith("/rpc/fail_summarization_job")) {
      return Response.json({ status: failure?.retryable ? "pending" : "failed", retryScheduled: Boolean(failure?.retryable) });
    }
    throw new Error(`Unexpected URL: ${input}`);
  };
  const summarize = async (input, config) => {
    assert.equal(config.apiKey, "xai-test-secret");
    assert.deepEqual(input.newEvents.map((event) => event.id), ["10", "11"]);
    assert.equal(Object.hasOwn(input, "existingClaims"), false);
    if (failure) throw failure;
    return {
      provider: "xai",
      model: "grok-test",
      modelVersion: "grok-test-20260915",
      providerRequestId: "xai-request-1",
      usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 5, totalTokens: 125, exactCostUsd: 0.0002 },
      output: gatewayOutput
    };
  };
  return { env, fetch, summarize, calls };
}

test("manual cycle queues one eligible conversation, decrypts its key, and completes atomically", async () => {
  const harness = await serviceHarness();
  const result = await runSummarizationCycle({ workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID, reason: "manual" }, harness.env, {
    fetch: harness.fetch,
    summarize: harness.summarize,
    now: NOW
  });
  assert.equal(result.status, "processed");
  assert.equal(result.jobs[0].status, "completed");
  assert.equal(Object.hasOwn(result.jobs[0], "claimCount"), false);
  const enqueue = harness.calls.find((call) => call.path.endsWith("/rpc/enqueue_summarization_job"));
  assert.deepEqual(enqueue.body.p_event_revisions, { "10": 1, "11": 1 });
  assert.equal(enqueue.body.p_prompt_version, "checkpoint-v1-runtime-5");
  const conversationQuery = harness.calls.find((call) => call.path.endsWith("/conversations") && !call.body);
  assert.equal(conversationQuery.search.includes(`id=eq.${CONVERSATION_ID}`), true);
  const complete = harness.calls.find((call) => call.path.endsWith("/rpc/complete_summarization_job"));
  assert.deepEqual(complete.body.p_output, { ...gatewayOutput, claims: [] });
  assert.equal(harness.calls.some((call) => call.path.endsWith("/memory_claims")), false);
  assert.equal(complete.body.p_usage.totalTokens, 125);
  assert.equal(complete.body.p_usage.estimatedCostUsd, null);
  assert.equal(JSON.stringify(harness.calls).includes("xai-test-secret"), false);
});

test("retryable provider failures return the job to the pending queue", async () => {
  const failure = new SummarizerGatewayError("provider_rate_limited", "The provider is temporarily rate limited.", { retryable: true, providerStatus: 429 });
  const harness = await serviceHarness({ failure });
  const result = await executeSummarizationJob(JOB_ID, harness.env, {
    fetch: harness.fetch,
    summarize: harness.summarize,
    now: NOW
  });
  assert.equal(result.status, "pending");
  assert.equal(result.retryScheduled, true);
  assert.equal(result.errorCode, "provider_rate_limited");
  assert.equal(result.errorDetail, "The provider is temporarily rate limited.");
  const failed = harness.calls.find((call) => call.path.endsWith("/rpc/fail_summarization_job"));
  assert.equal(failed.body.p_retryable, true);
  assert.equal(failed.body.p_error_detail.includes("rate limited"), true);
});

test("unchanged terminal failures are blocked before another model call", async () => {
  const harness = await serviceHarness({
    terminalFailure: {
      conversation_id: CONVERSATION_ID,
      new_event_ids: [10, 11],
      overlap_event_ids: [],
      event_revisions: { "10": 1, "11": 1 },
      provider: "xai",
      model: "grok-test",
      prompt_version: "checkpoint-v1-runtime-5",
      error_code: "provider_output_invalid",
      created_at: NOW.toISOString()
    }
  });
  const result = await runSummarizationCycle({ workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID, reason: "manual" }, harness.env, {
    fetch: harness.fetch,
    summarize: () => { throw new Error("The model must not be called."); },
    now: NOW
  });
  assert.equal(result.status, "protected");
  assert.equal(result.safeguards[0].modelCallPrevented, true);
  assert.equal(harness.calls.some((call) => call.path.endsWith("/rpc/enqueue_summarization_job")), false);
});

test("saving summarizer settings after an authentication failure allows one fresh model call", async () => {
  const harness = await serviceHarness({
    settingsOverride: { updated_at: "2026-09-15T14:05:00.000Z" },
    terminalFailure: {
      conversation_id: CONVERSATION_ID,
      new_event_ids: [10, 11],
      overlap_event_ids: [],
      event_revisions: { "10": 1, "11": 1 },
      provider: "xai",
      model: "grok-test",
      prompt_version: "checkpoint-v1-runtime-3",
      error_code: "provider_authentication_failed",
      created_at: "2026-09-15T14:00:00.000Z"
    }
  });
  const result = await runSummarizationCycle({ workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID, reason: "manual" }, harness.env, {
    fetch: harness.fetch,
    summarize: harness.summarize,
    now: NOW
  });
  assert.equal(result.status, "processed");
  assert.equal(result.jobs[0].status, "completed");
  assert.equal(harness.calls.some((call) => call.path.endsWith("/rpc/enqueue_summarization_job")), true);
});

test("scheduled-cycle limits bound database and model work", () => {
  assert.deepEqual(summarizationLimits, {
    maxScheduledJobsPerCycle: 3,
    maxWorkspacesPerCycle: 50,
    maxConversationsPerWorkspace: 500,
    staleProcessingMinutes: 5
  });
});

test("automatic summaries wait for chat inactivity even when several messages arrived", async () => {
  const sourceEvents = events.map((event) => ({ ...event, last_captured_at: "2026-09-15T14:25:00.000Z" }));
  const harness = await serviceHarness({ sourceEvents });
  const result = await runSummarizationCycle({ workspaceId: WORKSPACE_ID, reason: "scheduled" }, harness.env, {
    fetch: harness.fetch,
    summarize: () => { throw new Error("An active chat must not be summarized yet."); },
    now: NOW
  });
  assert.equal(result.status, "no_work");
  assert.equal(harness.calls.some((call) => call.path.endsWith("/rpc/enqueue_summarization_job")), false);
});

test("scheduled summaries reach imported chats beyond the former first-100 limit", async () => {
  const harness = await serviceHarness();
  const filler = Array.from({ length: 120 }, (_, index) => ({ id: `older-chat-${index}` }));
  const fetch = async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/conversations") && url.searchParams.get("select") === "id") {
      assert.equal(url.searchParams.get("limit"), "500");
      return Response.json([...filler, { id: CONVERSATION_ID }]);
    }
    return harness.fetch(input, options);
  };
  const result = await runSummarizationCycle({ workspaceId: WORKSPACE_ID, reason: "scheduled" }, harness.env, {
    fetch,
    summarize: harness.summarize,
    now: NOW
  });
  assert.equal(result.status, "processed");
  assert.equal(result.jobs[0].conversationId, CONVERSATION_ID);
});
