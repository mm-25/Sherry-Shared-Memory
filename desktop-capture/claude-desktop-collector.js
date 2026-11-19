import { rememberConversationMetadata } from "./source-metadata.js";
import { stableUuid } from "./batches.js";
import { MAX_PENDING_BATCHES, MAX_PENDING_BYTES } from "./collector.js";
import { createClaudeDesktopBatches, parseClaudeAxSnapshot, resolveClaudeDesktopIdentity } from "./claude-desktop.js";
import { validateCaptureBatch } from "../backend/src/validation.js";
import { recordCapturedBatch } from "./capture-log.js";

export async function collectClaudeDesktopSnapshot(state, store, raw, {
  workspaceId, deviceId, serverCapabilities = {}, now = () => new Date().toISOString(), isEnabled = async () => true
}) {
  if (!(await isEnabled())) return { addedEvents: 0, codeView: false };
  const parsed = parseClaudeAxSnapshot(raw);
  if (parsed.codeView) return { addedEvents: 0, codeView: true };
  const capturedAt = now();
  const localConversationId = resolveClaudeDesktopIdentity(state, parsed, capturedAt);
  const batches = createClaudeDesktopBatches({ ...parsed, localConversationId },
    { workspaceId, deviceId, capturedAt, serverCapabilities });
  let addedEvents = 0;
  for (const original of batches) {
    if (!(await isEnabled())) break;
    const changed = original.events.filter((event) => state.seen[event.eventId] !== event.contentHash);
    if (!changed.length) continue;
    const { batchId: _unused, ...basis } = original;
    const candidateBasis = { ...basis, events: changed };
    const batch = { ...candidateBasis, batchId: stableUuid(JSON.stringify(candidateBasis)) };
    const valid = validateCaptureBatch(batch);
    if (!valid.ok) throw new Error(`Claude desktop batch invalid: ${valid.errors[0]?.path}`);
    const pending = [...state.pending, { batch, attempts: 0, nextAttemptAt: null }];
    if (pending.length > MAX_PENDING_BATCHES || Buffer.byteLength(JSON.stringify(pending)) > MAX_PENDING_BYTES) {
      state.lastError = "Encrypted capture queue is full; Claude desktop will retry.";
      break;
    }
    state.pending = pending;
    recordCapturedBatch(state, batch);
    rememberConversationMetadata(state, batch);
    for (const event of changed) { state.seen[event.eventId] = event.contentHash; addedEvents++; }
    state.lastCaptureAt = capturedAt;
    await store.save(state);
  }
  await store.save(state);
  return { addedEvents, codeView: false, localConversationId };
}
