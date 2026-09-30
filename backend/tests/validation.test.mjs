import assert from "node:assert/strict";
import test from "node:test";
import { validateCaptureBatch } from "../src/validation.js";
import { validBatch, validBatchV2 } from "./fixtures.mjs";

test("accepts and normalizes a valid ChatGPT capture batch", () => {
  const result = validateCaptureBatch(validBatch());
  assert.equal(result.ok, true);
  assert.equal(result.value.events.length, 1);
  assert.equal(result.value.events[0].provider, "chatgpt");
});

test("rejects unsupported provider hosts and malformed batch identifiers", () => {
  const payload = validBatch({ batchId: "not-a-uuid" });
  payload.events[0].sourceUrl = "https://example.com/not-chatgpt";
  const result = validateCaptureBatch(payload);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.path), ["batchId", "events[0].sourceUrl"]);
});

test("rejects empty and oversized event batches", () => {
  assert.equal(validateCaptureBatch(validBatch({ events: [] })).ok, false);
  const events = Array.from({ length: 101 }, () => validBatch().events[0]);
  assert.equal(validateCaptureBatch(validBatch({ events })).ok, false);
});

test("accepts and normalizes Capture API v2 browser provenance", () => {
  const result = validateCaptureBatch(validBatchV2());
  assert.equal(result.ok, true);
  assert.equal(result.value.schemaVersion, 2);
  assert.equal(result.value.providerFamily, "openai");
  assert.equal(result.value.product, "chatgpt");
  assert.equal(result.value.captureClient.deviceId, "device:browser-test");
  assert.equal(result.value.events[0].sourceLocator, "web:chatgpt:conversation-123");
});

test("rejects mismatched provider families and incomplete v2 capture clients", () => {
  const payload = validBatchV2({
    providerFamily: "google",
    captureClient: { type: "browser_dom" }
  });
  const result = validateCaptureBatch(payload);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.path), [
    "providerFamily",
    "captureClient.adapterVersion",
    "captureClient.deviceId",
    "captureClient.os",
    "captureClient.captureSessionId"
  ]);
});

test("allows a native v2 event to use a source locator instead of a URL", () => {
  const payload = validBatchV2({
    provider: "codex",
    providerFamily: "openai",
    product: "codex",
    surface: "cli",
    reason: "hook",
    captureClient: {
      type: "structured_hook",
      adapterVersion: "1.0.0",
      deviceId: "device:codex-test",
      os: "macos",
      appVersion: "1.2.3",
      captureSessionId: "session:codex-test"
    },
    events: [{
      ...validBatch().events[0],
      provider: "codex",
      sourceUrl: null,
      sourceLocator: "codex-session:local-123"
    }]
  });
  const result = validateCaptureBatch(payload);
  assert.equal(result.ok, true);
  assert.equal(result.value.events[0].sourceUrl, null);
});
