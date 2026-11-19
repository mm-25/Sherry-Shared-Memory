import test from "node:test";
import assert from "node:assert/strict";
import { uploadReceiptError } from "../src/upload-receipt.js";

const batch = { batchId: "metadata-test", events: [], conversationUpdates: [{ conversationId: "one" }] };
const receipt = { ok: true, batchId: batch.batchId, result: { status: "committed", received: 0, inserted: 0, updated: 0, duplicates: 0, metadataReceived: 1, metadataUpdated: 1 } };

test("metadata-only upload requires exact confirmation without inventing message counts", () => {
  assert.equal(uploadReceiptError(batch, receipt), null);
  assert.equal(uploadReceiptError(batch, { ...receipt, result: { ...receipt.result, metadataUpdated: 0 } }), null);
  for (const result of [
    { ...receipt.result, metadataReceived: undefined },
    { ...receipt.result, metadataReceived: 0 },
    { ...receipt.result, metadataUpdated: 2 },
    { ...receipt.result, metadataUpdated: -1 },
    { ...receipt.result, metadataUpdated: 0.5 },
    { ...receipt.result, received: 1, inserted: 1 },
    { ...receipt.result, status: "processing" }
  ]) assert.ok(uploadReceiptError(batch, { ...receipt, result }));
  assert.ok(uploadReceiptError(batch, { ...receipt, batchId: "different" }));
  assert.ok(uploadReceiptError({ ...batch, conversationUpdates: [] }, receipt));
});

test("mixed batches confirm messages and metadata independently while legacy receipts remain valid", () => {
  const eventReceipt = { ...receipt, result: { ...receipt.result, received: 2, inserted: 1, duplicates: 1 } };
  assert.equal(uploadReceiptError({ ...batch, events: [{}, {}] }, eventReceipt), null);
  assert.ok(uploadReceiptError({ ...batch, events: [{}, {}] }, { ...eventReceipt, result: { ...eventReceipt.result, metadataReceived: 0 } }));
  const legacy = { ok: true, batchId: "legacy", result: { status: "committed", received: 1, inserted: 1, updated: 0, duplicates: 0 } };
  assert.equal(uploadReceiptError({ batchId: "legacy", events: [{}] }, legacy), null);
});
