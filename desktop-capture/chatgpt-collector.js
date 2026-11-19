import { createChatGptBatches } from "./chatgpt.js";
import { stableUuid } from "./batches.js";
import { parseChatGptAxSnapshot, resolveLocalChatGptIdentity } from "./chatgpt-ax.js";
import { MAX_PENDING_BATCHES, MAX_PENDING_BYTES } from "./collector.js";
import { validateCaptureBatch } from "../backend/src/validation.js";
import { recordCapturedBatch } from "./capture-log.js";

export async function collectChatGptSnapshot(state, store, rawSnapshot, {
  workspaceId, deviceId, now = () => new Date().toISOString(), isEnabled = async () => true
}) {
  if (!(await isEnabled())) return { addedEvents: 0, pendingBatches: state.pending.length };
  const parsed = parseChatGptAxSnapshot(rawSnapshot);
  const observedAt = now();
  const localConversationId = resolveLocalChatGptIdentity(state, parsed, observedAt);
  const batches = createChatGptBatches({ ...parsed, localConversationId }, {
    workspaceId, deviceId, capturedAt: observedAt
  });
  let addedEvents = 0;
  for (const original of batches) {
    if (!(await isEnabled())) break;
    const changed = original.events.filter((event) => state.seen[event.eventId] !== event.contentHash);
    if (!changed.length) continue;
    const { batchId: _unused, ...basis } = original;
    const candidateBasis = { ...basis, events: changed };
    const batch = { ...candidateBasis, batchId: stableUuid(JSON.stringify(candidateBasis)) };
    const validation = validateCaptureBatch(batch);
    if (!validation.ok) throw new Error(`ChatGPT batch failed validation at ${validation.errors[0]?.path || "unknown field"}.`);
    const pending = [...state.pending, { batch, attempts: 0, nextAttemptAt: null }];
    if (pending.length > MAX_PENDING_BATCHES || Buffer.byteLength(JSON.stringify(pending)) > MAX_PENDING_BYTES) {
      state.lastError = "Encrypted capture queue is full; ChatGPT observation was not queued.";
      break;
    }
    state.pending = pending;
    recordCapturedBatch(state, batch, { sourceVerified: true });
    for (const event of changed) state.seen[event.eventId] = event.contentHash;
    addedEvents += changed.length;
    state.lastCaptureAt = observedAt;
    await store.save(state);
  }
  await store.save(state);
  return { addedEvents, pendingBatches: state.pending.length, localConversationId };
}
