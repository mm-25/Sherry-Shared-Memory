import { captureEvidenceFor, observationWarnings } from "./capture-evidence.js";

function sourceTime(event) {
  const metadata = event.source_metadata || event.sourceMetadata;
  return !metadata || metadata.timestampBasis === "source" ? event.message_timestamp : null;
}

function validTimestamp(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : null;
}

function newest(values) {
  return values.reduce((latest, value) => {
    const time = validTimestamp(value);
    return time !== null && (latest === null || time > latest) ? time : latest;
  }, null);
}

export function conversationActivity(conversation, sourceMessages = [], liveCaptures = []) {
  const sourceTime = newest(sourceMessages);
  const liveTime = newest(liveCaptures);
  const captureTime = validTimestamp(conversation.last_captured_at);
  const latest = sourceTime === null ? liveTime : liveTime === null ? sourceTime : Math.max(sourceTime, liveTime);
  if (latest !== null) {
    return {
      last_activity_at: new Date(latest).toISOString(),
      last_activity_basis: sourceTime !== null && sourceTime >= (liveTime ?? -Infinity) ? "source_message" : "first_captured_message"
    };
  }
  return { last_activity_at: captureTime === null ? null : new Date(captureTime).toISOString(), last_activity_basis: "capture" };
}

export function activityFromEvents(conversation, events) {
  const firstSeenByIdentity = new Map();
  for (const event of events) {
    if (sourceTime(event) || String(event.source_locator || "").startsWith("historical-import:")) continue;
    const text = String(event.text_content || "");
    const metadata = event.source_metadata || event.sourceMetadata;
    const identity = metadata && metadata.messageIdentity !== "provider" ? `event:${event.event_key || event.id}` : event.provider_message_id
      ? `id:${event.provider_message_id}`
      : text.length >= 60 ? `text:${event.role}:${text}` : `event:${event.event_key || event.id}`;
    const firstSeen = validTimestamp(event.first_captured_at || event.captured_at);
    const previous = firstSeenByIdentity.get(identity);
    if (firstSeen !== null && (previous === undefined || firstSeen < previous)) firstSeenByIdentity.set(identity, firstSeen);
  }
  return conversationActivity(
    conversation,
    events.map(sourceTime),
    [...firstSeenByIdentity.values()].map((time) => new Date(time).toISOString())
  );
}

export function transcriptCoverage(conversation, events) {
  const reasons = [];
  if (["partial", "gap_detected", "awaiting_backfill"].includes(conversation.coverage_state) || conversation.gap_detected) {
    reasons.push("Capture reported a partial range or gap.");
  }
  for (const event of events) reasons.push(...observationWarnings(event));
  return { status: reasons.length ? "partial_or_uncertain" : "observed_range", reasons: [...new Set(reasons)] };
}

export function orderTranscriptEvents(events) {
  const sessionOrdered = events.length > 0 && events.every(event =>
    captureEvidenceFor(event)?.orderBasis === "session_sequence" && event.source_locator === events[0].source_locator);
  return [...events].sort((left, right) => {
    if (sessionOrdered) return Number(left.sequence) - Number(right.sequence) || Number(left.id || 0) - Number(right.id || 0);
    const leftTime = validTimestamp(sourceTime(left) || left.first_captured_at || left.captured_at) ?? 0;
    const rightTime = validTimestamp(sourceTime(right) || right.first_captured_at || right.captured_at) ?? 0;
    return leftTime - rightTime || Number(left.sequence || 0) - Number(right.sequence || 0) || Number(left.id || 0) - Number(right.id || 0);
  });
}
