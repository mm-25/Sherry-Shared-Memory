import assert from "node:assert/strict";
import test from "node:test";
import { redactCaptureBatch, redactText, redactUrl } from "../src/redaction.js";
import { validBatch } from "./fixtures.mjs";

test("redacts known credentials, labelled secrets, and valid payment-card numbers", () => {
  const result = redactText("API key: sk-ant-abcdefghijklmnopqrstuvwxyz and card 4111 1111 1111 1111");
  assert.equal(result.value.includes("sk-ant-"), false);
  assert.equal(result.value.includes("4111"), false);
  assert.equal(result.counts.api_key, 1);
  assert.equal(result.counts.payment_card, 1);
});

test("does not redact an ordinary long number that fails the Luhn check", () => {
  const result = redactText("Design reference 4111 1111 1111 1112");
  assert.equal(result.value, "Design reference 4111 1111 1111 1112");
});

test("redacts secrets in URL query parameters", () => {
  const result = redactUrl("https://example.com/path?token=secret-value&view=full");
  assert.equal(result.count, 1);
  assert.equal(result.value.includes("secret-value"), false);
  assert.equal(new URL(result.value).searchParams.get("view"), "full");
});

test("redacts URL passwords and OAuth-style fragment tokens", () => {
  const result = redactUrl("https://person:secret-password@example.com/callback#access_token=secret-token&view=full");
  assert.equal(result.count, 2);
  assert.equal(result.value.includes("secret-password"), false);
  assert.equal(result.value.includes("secret-token"), false);
  assert.equal(new URL(result.value).hash.includes("view=full"), true);
});

test("returns an audit-safe batch redaction summary without original values", () => {
  const payload = validBatch();
  payload.events[0].text = "password=hunter2";
  const result = redactCaptureBatch(payload);
  assert.equal(result.summary.total, 1);
  assert.deepEqual(result.summary.events[0].counts, { credential: 1 });
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
});

test("drops unknown attachment fields and redacts allowed metadata before archiving", () => {
  const payload = validBatch();
  payload.events[0].attachments = [{
    kind: "a",
    name: "password=hunter2",
    url: "https://files.example/download?token=secret-value",
    extraPrivateField: "secret-that-must-not-be-stored"
  }];
  const result = redactCaptureBatch(payload);
  const archived = JSON.stringify(result.batch);
  assert.equal(archived.includes("hunter2"), false);
  assert.equal(archived.includes("secret-value"), false);
  assert.equal(archived.includes("secret-that-must-not-be-stored"), false);
  assert.equal(result.summary.byType.credential, 1);
  assert.equal(result.summary.byType.url_secret, 1);
});

test("redacts native captures with a source locator and no source URL", () => {
  const payload = validBatch();
  payload.events[0].sourceUrl = null;
  payload.events[0].sourceLocator = "session:password=hunter2";
  const result = redactCaptureBatch(payload);
  assert.equal(result.batch.events[0].sourceUrl, null);
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
  assert.equal(result.summary.byType.credential, 1);
});
