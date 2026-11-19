import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const runtimeSource = source.slice(source.indexOf("function extensionRuntime()"), source.indexOf("function extensionBridgeRequest("));
const messageSource = source.slice(source.indexOf("function extensionMessage("), source.indexOf("function setExtensionControlsDisabled("));
assert.ok(runtimeSource && messageSource);
const noReceiver = "Could not establish connection. Receiving end does not exist.";

function connection({ error, response = { ok: true, version: "0.4.19" }, bridgePresent = true, runtimePresent = true, promiseAlsoRejects = false } = {}) {
  const bridgeMessages = [];
  const chrome = runtimePresent ? { runtime: {
    lastError: null,
    sendMessage(_id, _message, callback) {
      this.lastError = error ? { message: error } : null;
      callback(error ? undefined : response);
      this.lastError = null;
      if (promiseAlsoRejects) return Promise.reject(new Error(error));
    }
  } } : undefined;
  const context = {
    chrome,
    document: { getElementById: () => bridgePresent ? {} : null },
    EXTENSION_ID: "test-installed-id",
    async bridgedExtensionMessage(message) {
      bridgeMessages.push(message);
      return { ok: true, version: "0.4.19", receipt: "page-bridge" };
    }
  };
  vm.runInNewContext(`${runtimeSource}\n${messageSource}\nglobalThis.request = extensionMessage;`, context);
  return { request: context.request, bridgeMessages };
}

test("website status recovers through its present page bridge when direct messaging has no receiver", async () => {
  const client = connection({ error: noReceiver });
  const result = await client.request({ type: "GET_STATUS" });
  assert.equal(result.version, "0.4.19");
  assert.equal(result.receipt, "page-bridge");
});

test("a definitive absent receiver sends a setting change through the bridge only once", async () => {
  const client = connection({ error: noReceiver, promiseAlsoRejects: true });
  const message = { type: "UPDATE_SETTINGS", payload: { captureEnabled: false } };
  assert.equal((await client.request(message)).receipt, "page-bridge");
  await Promise.resolve();
  assert.deepEqual(client.bridgeMessages, [message]);
});

test("an ambiguous response failure does not replay a setting change", async () => {
  const client = connection({ error: "The message port closed before a response was received." });
  await assert.rejects(client.request({ type: "UPDATE_SETTINGS" }), /message port closed/);
  assert.equal(client.bridgeMessages.length, 0);
});

test("a denied operation is not retried through another route", async () => {
  const client = connection({ response: { ok: false, error: "This account cannot perform that operation." } });
  await assert.rejects(client.request({ type: "UPDATE_INGESTION_CONFIG" }), /cannot perform/);
  assert.equal(client.bridgeMessages.length, 0);
});

test("an absent bridge preserves the original missing-receiver error", async () => {
  const client = connection({ error: noReceiver, bridgePresent: false });
  await assert.rejects(client.request({ type: "GET_STATUS" }), /Receiving end does not exist/);
  assert.equal(client.bridgeMessages.length, 0);
});

test("a successful direct receipt is not also sent through the bridge", async () => {
  const client = connection();
  assert.equal((await client.request({ type: "GET_STATUS" })).version, "0.4.19");
  assert.equal(client.bridgeMessages.length, 0);
});

test("browsers without the direct runtime keep using the existing page bridge", async () => {
  const client = connection({ runtimePresent: false });
  assert.equal((await client.request({ type: "GET_STATUS" })).receipt, "page-bridge");
});
