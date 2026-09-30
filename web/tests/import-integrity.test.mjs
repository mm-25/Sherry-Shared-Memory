import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../import-integrity.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const { verifyReceipt } = context.SherryImportIntegrity;

test("import receipt confirms every committed message, including deduplicated ones", () => {
  assert.equal(verifyReceipt({ ok: true, result: { status: "committed", received: 3, inserted: 1, updated: 1, duplicates: 1 } }, 3), 3);
});

test("import receipt rejects partial, pending, and tombstoned batches", () => {
  assert.throws(() => verifyReceipt({ ok: true, result: { status: "committed", received: 2, inserted: 2, updated: 0, duplicates: 0 } }, 3));
  assert.throws(() => verifyReceipt({ ok: true, result: { status: "processing", received: 3, inserted: 3, updated: 0, duplicates: 0 } }, 3));
  assert.throws(() => verifyReceipt({ ok: true, ignoredDeletedEvents: 3 }, 3), /deleted conversation/);
});
