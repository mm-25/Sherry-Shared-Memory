import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../import-integrity.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const { verifyReceipt, verifyImportPlan, verifyReadback } = context.SherryImportIntegrity;

test("import receipt confirms every committed message, including deduplicated ones", () => {
  assert.equal(verifyReceipt({ ok: true, result: { status: "committed", received: 3, inserted: 1, updated: 1, duplicates: 1 } }, 3), 3);
});

test("import receipt rejects partial, pending, and tombstoned batches", () => {
  assert.throws(() => verifyReceipt({ ok: true, result: { status: "committed", received: 2, inserted: 2, updated: 0, duplicates: 0 } }, 3));
  assert.throws(() => verifyReceipt({ ok: true, result: { status: "processing", received: 3, inserted: 3, updated: 0, duplicates: 0 } }, 3));
  assert.throws(() => verifyReceipt({ ok: true, ignoredDeletedEvents: 3 }, 3), /deleted conversation/);
});

test("readback checks every source message identity and role after upload", () => {
  const expected = [{ id: "a", role: "user" }, { id: "b", role: "assistant" }];
  const stored = [{ provider_message_id: "b", role: "assistant" }, { provider_message_id: "a", role: "user" }];
  assert.equal(verifyReadback(expected, stored), 2);
  assert.throws(() => verifyReadback(expected, stored.slice(0, 1)), /could not find every/);
  assert.throws(() => verifyReadback(expected, [{ ...stored[0], role: "user" }, stored[1]]), /could not find every/);
  assert.throws(() => verifyReadback([expected[0], expected[0]], stored), /repeats a message identity/);
});

test("import preflight rejects repeated source identities before sending batches", () => {
  const chat = { id: "one", messages: [{ id: "a" }, { id: "b" }] };
  assert.equal(verifyImportPlan([chat]), 2);
  assert.throws(() => verifyImportPlan([chat, chat]), /repeats a chat identity/);
  assert.throws(() => verifyImportPlan([{ ...chat, messages: [{ id: "a" }, { id: "a" }] }]), /repeats a message identity/);
});
