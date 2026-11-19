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
  const expected = [{ id: "a", role: "user", text: "A", timestamp: null }, { id: "b", role: "assistant", text: "B", timestamp: null }];
  const stored = [{ provider_message_id: "b", role: "assistant", text_content: "B", message_timestamp: null, sequence: 1 }, { provider_message_id: "a", role: "user", text_content: "A", message_timestamp: null, sequence: 0 }];
  const options = { verificationVersion: 2, redactText: (value) => ({ value }) };
  assert.equal(verifyReadback(expected, stored, options), 2);
  assert.throws(() => verifyReadback(expected, stored.slice(0, 1), options), /could not find every/);
  assert.throws(() => verifyReadback(expected, [{ ...stored[0], role: "user" }, stored[1]], options), /could not find every/);
  assert.throws(() => verifyReadback([expected[0], expected[0]], stored, options), /repeats a message identity/);
});

test("import preflight rejects repeated source identities before sending batches", () => {
  const chat = { id: "one", messages: [{ id: "a" }, { id: "b" }] };
  assert.equal(verifyImportPlan([chat]), 2);
  assert.throws(() => verifyImportPlan([chat, chat]), /repeats a chat identity/);
  assert.throws(() => verifyImportPlan([{ ...chat, messages: [{ id: "a" }, { id: "a" }] }]), /repeats a message identity/);
});

test("import receipts reject a foreign batch and malformed outcome counts", () => {
  const receipt = { ok: true, batchId: "expected", result: { status: "committed", received: 2, inserted: 2, updated: 0, duplicates: 0 } };
  assert.equal(verifyReceipt(receipt, 2, "expected"), 2);
  assert.throws(() => verifyReceipt({ ...receipt, batchId: "foreign" }, 2, "expected"), /confirm/);
  for (const result of [
    { received: 2, inserted: 3, updated: -1, duplicates: 0 },
    { received: 2, inserted: "2", updated: 0, duplicates: 0 },
    { received: 2, inserted: 1.5, updated: 0.5, duplicates: 0 }
  ]) assert.throws(() => verifyReceipt({ ...receipt, result: { ...result, status: "committed" } }, 2, "expected"), /confirm/);
});

test("rich readback rejects altered text, dates, sequence and legacy identity-only responses", () => {
  const expected = [{ id: "a", role: "user", text: "Code:\n  x = 1", timestamp: null, sequence: 3 }];
  const stored = [{ provider_message_id: "a", role: "user", text_content: "Code:\n  x = 1", message_timestamp: null, sequence: 3 }];
  const options = { verificationVersion: 2, redactText: (text) => ({ value: text }) };
  assert.equal(verifyReadback(expected, stored, options), 1);
  for (const changed of [
    { text_content: "Code: x = 1" }, { sequence: 4 }, { message_timestamp: "2026-10-30T10:00:00Z" }, { text_content: undefined }
  ]) assert.throws(() => verifyReadback(expected, [{ ...stored[0], ...changed }], options), /match|verify|find/);
  assert.throws(() => verifyReadback(expected, stored), /verification|verify/);
});

test("import preflight rejects IDs that cloud normalization would shorten or change", () => {
  assert.throws(() => verifyImportPlan([{ id: "x".repeat(513), messages: [{ id: "message" }] }]), /identity/);
  assert.throws(() => verifyImportPlan([{ id: "chat", messages: [{ id: " message " }] }]), /identity/);
});
