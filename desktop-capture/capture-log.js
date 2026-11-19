// Stored inside the encrypted state, never in the redacted status file.
export const CAPTURE_LOG_LIMIT = 50;
export const CAPTURE_LOG_BYTES = 2 * 1024 * 1024;
export const CAPTURE_SOURCES = ["codex", "antigravity", "chatgpt", "claude"];

function sourceFor(batch) {
  return batch.provider === "claude_code" ? "claude" : batch.provider;
}

export function recordCapturedBatch(state, batch, { sourceVerified = false } = {}) {
  const source = sourceFor(batch);
  if (!CAPTURE_SOURCES.includes(source)) return;
  const history = state.recentCaptures ||= [];
  for (const event of batch.events) {
    const previous = history.findIndex((item) => item.source === source && item.event.eventId === event.eventId);
    const item = { source, sourceVerified, batchId: batch.batchId, event: structuredClone(event),
      capturedAt: event.capturedAt || batch.clientCreatedAt, delivery: "queued",
      uploadedAt: null, error: null, httpStatus: null, attempts: 0, nextAttemptAt: null };
    if (previous >= 0) history.splice(previous, 1);
    history.push(item);
  }
  // Retain the newest items per source within both a count and byte budget.
  const counts = {}, sizes = {};
  state.recentCaptures = history.slice().reverse().filter((item) => {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    const count = counts[item.source] || 0, size = sizes[item.source] || 0;
    if (count >= CAPTURE_LOG_LIMIT || size + bytes > CAPTURE_LOG_BYTES) return false;
    counts[item.source] = count + 1;
    sizes[item.source] = size + bytes;
    return true;
  }).reverse();
}

export function updateCaptureDelivery(state, item, delivery, {
  uploadedAt = null, error = null, httpStatus = null
} = {}) {
  for (const capture of state.recentCaptures || []) {
    if (capture.batchId !== item.batch.batchId) continue;
    Object.assign(capture, { delivery, uploadedAt, error, httpStatus,
      attempts: item.attempts, nextAttemptAt: item.nextAttemptAt || null });
  }
}

export function captureLogView(state) {
  // Explicit allowlist: account tokens, queue keys and other state stay private.
  return { captures: state.recentCaptures || [], checks: state.sourceChecks || {},
    limitPerSource: CAPTURE_LOG_LIMIT, bytesPerSource: CAPTURE_LOG_BYTES };
}
