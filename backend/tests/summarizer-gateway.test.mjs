import assert from "node:assert/strict";
import test from "node:test";
import {
  SummarizerGatewayError,
  checkpointOutputSchema,
  summarizeCheckpoint,
  validateCheckpointOutput
} from "../src/summarizer-gateway.js";

const input = {
  conversation: {
    title: "Memory Test",
    provider: "chatgpt",
    sourceUrl: "https://chatgpt.com/c/test"
  },
  previousSummary: "The user is planning a shared memory product.",
  overlapEvents: [{ id: "100", role: "assistant", text: "Which providers should it support?", revision: 1 }],
  newEvents: [{ id: "101", role: "user", text: "Include Grok as a provider.", revision: 1 }]
};

const output = {
  summary: "The shared memory product should include Grok as a supported provider.",
  topics: ["Provider support"],
  keyDecisions: [{ text: "Include Grok.", evidenceEventIds: ["101"] }],
  openThreads: []
};

function jsonResponse(body, headers = {}) {
  return Response.json(body, { headers });
}

test("Anthropic adapter sends a strict schema and keeps the key out of the request body", async () => {
  const apiKey = "anthropic-secret";
  let request;
  const result = await summarizeCheckpoint(input, { provider: "anthropic", model: "claude-test", apiKey }, {
    fetch: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return jsonResponse({
        id: "msg_1",
        model: "claude-test-20260915",
        content: [{ type: "text", text: JSON.stringify(output) }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10 }
      });
    }
  });

  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.options.headers["x-api-key"], apiKey);
  assert.equal(JSON.stringify(request.body).includes(apiKey), false);
  assert.deepEqual(request.body.output_config.format.schema, checkpointOutputSchema);
  assert.equal(request.body.max_tokens, 8192);
  assert.equal(request.body.system.includes("untrusted conversation evidence"), true);
  assert.equal(request.body.system.includes("information-preserving memory abstract"), true);
  assert.equal(request.body.system.includes("Provider-native memory actions do not erase"), true);
  assert.equal(request.body.messages[0].content.includes('"id":"101"'), true);
  assert.equal(request.body.messages[0].content.includes('existingMemoryClaims'), false);
  assert.equal(JSON.stringify(request.body).includes('"claims"'), false);
  assert.equal(result.output.summary, output.summary);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 10, exactCostUsd: null });
});

test("Anthropic output-limit truncation is reported before trying to parse incomplete JSON", async () => {
  await assert.rejects(
    () => summarizeCheckpoint(input, { provider: "anthropic", model: "claude-test", apiKey: "secret" }, {
      fetch: async () => jsonResponse({
        id: "msg_truncated",
        stop_reason: "max_tokens",
        content: [{ type: "text", text: '{"summary":"unfinished' }]
      })
    }),
    (error) => error instanceof SummarizerGatewayError
      && error.code === "provider_output_truncated"
      && error.message.includes("output limit")
  );
});

test("Anthropic refusals are reported without parsing them as summaries", async () => {
  await assert.rejects(
    () => summarizeCheckpoint(input, { provider: "anthropic", model: "claude-test", apiKey: "secret" }, {
      fetch: async () => jsonResponse({ stop_reason: "refusal", content: [{ type: "text", text: "I cannot help." }] })
    }),
    (error) => error instanceof SummarizerGatewayError && error.code === "provider_output_refused"
  );
});

test("OpenAI adapter disables provider-side storage and normalizes usage", async () => {
  const apiKey = "openai-secret";
  let request;
  const result = await summarizeCheckpoint(input, { provider: "openai", model: "gpt-test", apiKey }, {
    fetch: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return jsonResponse({
        id: "resp_1",
        model: "gpt-test-2026-09-15",
        output_text: JSON.stringify(output),
        usage: { input_tokens: 90, output_tokens: 20, input_tokens_details: { cached_tokens: 5 } }
      });
    }
  });

  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(JSON.stringify(request.body).includes(apiKey), false);
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.text.format.schema, checkpointOutputSchema);
  assert.equal(result.providerRequestId, "resp_1");
  assert.equal(result.usage.cachedInputTokens, 5);
});

test("Google adapter uses responseJsonSchema and the API-key header", async () => {
  const apiKey = "google-secret";
  let request;
  const result = await summarizeCheckpoint(input, { provider: "google", model: "gemini-test", apiKey }, {
    fetch: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return jsonResponse({
        responseId: "google_1",
        modelVersion: "gemini-test-002",
        candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
        usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20, cachedContentTokenCount: 4 }
      });
    }
  });

  assert.equal(request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
  assert.equal(request.options.headers["x-goog-api-key"], apiKey);
  assert.equal(JSON.stringify(request.body).includes(apiKey), false);
  assert.deepEqual(request.body.generationConfig.responseJsonSchema, checkpointOutputSchema);
  assert.equal(result.modelVersion, "gemini-test-002");
  assert.equal(result.usage.totalTokens, 100);
});

test("xAI adapter supports Grok structured output and exact cost ticks", async () => {
  const apiKey = "xai-secret";
  let request;
  const result = await summarizeCheckpoint(input, { provider: "xai", model: "grok-test", apiKey }, {
    fetch: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return jsonResponse({
        id: "xai_1",
        model: "grok-test-20260915",
        choices: [{ message: { content: JSON.stringify(output) } }],
        usage: {
          prompt_tokens: 70,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 3 },
          cost_in_usd_ticks: 1_500_000
        }
      });
    }
  });

  assert.equal(request.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(request.options.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(JSON.stringify(request.body).includes(apiKey), false);
  assert.deepEqual(request.body.response_format.json_schema.schema, checkpointOutputSchema);
  assert.equal(request.body.messages[0].role, "system");
  assert.equal(result.provider, "xai");
  assert.equal(result.usage.exactCostUsd, 0.00015);
});

test("rejects citations to events that were not supplied to the model", () => {
  const unsupported = structuredClone(output);
  unsupported.keyDecisions[0].evidenceEventIds = ["999"];
  assert.throws(
    () => validateCheckpointOutput(unsupported, input),
    (error) => error instanceof SummarizerGatewayError && error.code === "provider_output_invalid"
  );
});

test("rejects a retired claims field in checkpoint output", () => {
  const unsupported = structuredClone(output);
  unsupported.claims = [];
  assert.throws(
    () => validateCheckpointOutput(unsupported, input),
    (error) => error instanceof SummarizerGatewayError
      && error.code === "provider_output_invalid"
  );
});

test("production summarization keeps the summary without extracting claims", async () => {
  const result = await summarizeCheckpoint(input, { provider: "anthropic", model: "claude-test", apiKey: "secret" }, {
    fetch: async () => jsonResponse({
      id: "msg_partial",
      model: "claude-test",
      content: [{ type: "text", text: JSON.stringify(output) }],
      usage: { input_tokens: 100, output_tokens: 20 }
    })
  });
  assert.equal(result.output.summary, output.summary);
  assert.equal(Object.hasOwn(result.output, "claims"), false);
  assert.equal(result.warnings.length, 0);
});

test("production summarization accepts fenced JSON and drops invalid decision evidence", async () => {
  const partiallyUnsupported = structuredClone(output);
  partiallyUnsupported.keyDecisions.push({ text: "Unsupported decision", evidenceEventIds: ["missing-event"] });
  const result = await summarizeCheckpoint(input, { provider: "anthropic", model: "claude-test", apiKey: "secret" }, {
    fetch: async () => jsonResponse({
      id: "msg_fenced",
      model: "claude-test",
      content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(partiallyUnsupported)}\n\`\`\`` }],
      usage: { input_tokens: 100, output_tokens: 20 }
    })
  });
  assert.equal(result.output.summary, output.summary);
  assert.equal(result.output.keyDecisions.length, output.keyDecisions.length);
  assert.equal(result.warnings.some((warning) => warning.code === "unsupported_evidence_item_dropped"), true);
});

test("marks a rate limit as retryable even when the provider error body is not JSON", async () => {
  await assert.rejects(
    () => summarizeCheckpoint(input, { provider: "xai", model: "grok-test", apiKey: "xai-secret" }, {
      fetch: async () => new Response("rate limited", { status: 429 })
    }),
    (error) => error instanceof SummarizerGatewayError && error.code === "provider_rate_limited" && error.retryable === true
  );
});

test("rejects unsupported providers before making a network request", async () => {
  let called = false;
  await assert.rejects(
    () => summarizeCheckpoint(input, { provider: "unknown", model: "test", apiKey: "secret-key" }, {
      fetch: async () => {
        called = true;
        return jsonResponse({});
      }
    }),
    (error) => error instanceof SummarizerGatewayError && error.code === "unsupported_summarizer_provider"
  );
  assert.equal(called, false);
});


test("summary input preserves mobile uncertainty and distinguishes capture time from original date", async () => {
  const native = structuredClone(input);
  native.newEvents[0] = { ...native.newEvents[0], capturedAt: "2026-10-02T06:00:00Z", messageTimestamp: null,
    sequence: 499999, coverage: "partial", captureEvidence: { timestampBasis: "observed", completeness: "possibly_clipped", conversationIdentity: "local_session" } };
  let body;
  await summarizeCheckpoint(native, { provider: "anthropic", model: "claude-test", apiKey: "test-secret" }, {
    fetch: async (_, options) => {
      body = JSON.parse(options.body);
      return jsonResponse({ id: "test", model: "claude-test", content: [{ type: "text", text: JSON.stringify(output) }], usage: { input_tokens: 10, output_tokens: 10 } });
    }
  });
  assert.match(body.system, /original date is unknown/);
  assert.match(body.system, /Never interpret relative dates/);
  assert.match(body.messages[0].content, /"messageTimestamp":null/);
  assert.match(body.messages[0].content, /"completeness":"possibly_clipped"/);
  assert.match(body.messages[0].content, /"sequence":499999/);
});
