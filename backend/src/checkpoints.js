export const checkpointDefaults = Object.freeze({
  intervalMinutes: 10,
  continuityOverlapEvents: 2,
  maxNewEventsPerCheckpoint: 100
});

function compareEventIds(left, right) {
  const a = BigInt(String(left.id));
  const b = BigInt(String(right.id));
  return a < b ? -1 : a > b ? 1 : 0;
}

function eventAgeMinutes(event, now) {
  const observedAt = new Date(event.lastCapturedAt || event.capturedAt || event.createdAt).getTime();
  return Number.isFinite(observedAt) ? Math.max(0, (now.getTime() - observedAt) / 60000) : 0;
}

export function selectCheckpointInput({
  events,
  latestCheckpoint = null,
  includedRevisions = {},
  settings = {},
  now = new Date()
}) {
  const config = { ...checkpointDefaults, ...settings };
  const ordered = [...events].sort(compareEventIds);
  const previousHighWater = latestCheckpoint?.lastEventId == null
    ? 0n
    : BigInt(String(latestCheckpoint.lastEventId));

  const candidates = ordered.filter((event) => {
    const eventId = BigInt(String(event.id));
    const priorRevision = Number(includedRevisions[String(event.id)] || 0);
    return eventId > previousHighWater || Number(event.revision || 1) > priorRevision;
  });

  if (candidates.length === 0) return { eligible: false, reason: "no_changes" };

  const newestCandidate = candidates.reduce((newest, event) =>
    eventAgeMinutes(event, now) < eventAgeMinutes(newest, now) ? event : newest
  );
  if (eventAgeMinutes(newestCandidate, now) < config.intervalMinutes) {
    return { eligible: false, reason: "waiting_for_quiet_period", pendingEventCount: candidates.length };
  }

  const selectedNew = candidates.slice(0, config.maxNewEventsPerCheckpoint);
  const selectedIds = new Set(selectedNew.map((event) => String(event.id)));
  const firstSelectedIndex = ordered.findIndex((event) => selectedIds.has(String(event.id)));
  const overlap = ordered
    .slice(Math.max(0, firstSelectedIndex - config.continuityOverlapEvents), firstSelectedIndex)
    .filter((event) => !selectedIds.has(String(event.id)));
  const cursorEventId = selectedNew.reduce(
    (largest, event) => BigInt(String(event.id)) > largest ? BigInt(String(event.id)) : largest,
    previousHighWater
  );

  return {
    eligible: true,
    reason: "quiet_period_elapsed",
    newEvents: selectedNew,
    overlapEvents: overlap,
    newEventIds: selectedNew.map((event) => String(event.id)),
    overlapEventIds: overlap.map((event) => String(event.id)),
    cursorEventId: String(cursorEventId),
    hasMore: candidates.length > selectedNew.length
  };
}
