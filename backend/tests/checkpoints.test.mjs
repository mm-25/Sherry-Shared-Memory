import assert from "node:assert/strict";
import test from "node:test";
import { checkpointDefaults, selectCheckpointInput } from "../src/checkpoints.js";

const NOW = new Date("2026-09-15T13:00:00.000Z");
const event = (id, minutesAgo, revision = 1) => ({
  id: String(id),
  revision,
  capturedAt: new Date(NOW.getTime() - minutesAgo * 60000).toISOString(),
  role: Number(id) % 2 ? "user" : "assistant",
  text: `event ${id}`
});

test("uses a quiet-period gate instead of a message-count gate", () => {
  assert.deepEqual(checkpointDefaults, {
    intervalMinutes: 10,
    continuityOverlapEvents: 2,
    maxNewEventsPerCheckpoint: 100
  });
});

test("selects only events after the last checkpoint plus a small overlap", () => {
  const result = selectCheckpointInput({
    events: [event(1, 30), event(2, 25), event(3, 20), event(4, 11)],
    latestCheckpoint: { lastEventId: "2" },
    includedRevisions: { "1": 1, "2": 1 },
    now: NOW
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.newEventIds, ["3", "4"]);
  assert.deepEqual(result.overlapEventIds, ["1", "2"]);
  assert.equal(result.cursorEventId, "4");
});

test("waits for the most recent change to settle regardless of message count", () => {
  const recent = selectCheckpointInput({ events: [event(1, 5)], now: NOW });
  assert.deepEqual(recent, { eligible: false, reason: "waiting_for_quiet_period", pendingEventCount: 1 });

  const burst = selectCheckpointInput({ events: [event(1, 31), event(2, 2)], now: NOW });
  assert.deepEqual(burst, { eligible: false, reason: "waiting_for_quiet_period", pendingEventCount: 2 });

  const old = selectCheckpointInput({ events: [event(1, 11)], now: NOW });
  assert.equal(old.eligible, true);
  assert.equal(old.reason, "quiet_period_elapsed");
  const manual = selectCheckpointInput({ events: [event(1, 1)], settings: { intervalMinutes: 0 }, now: NOW });
  assert.equal(manual.eligible, true);
});

test("reprocesses a changed event revision without reprocessing unchanged events", () => {
  const result = selectCheckpointInput({
    events: [event(1, 20), event(2, 15, 2), event(3, 10)],
    latestCheckpoint: { lastEventId: "3" },
    includedRevisions: { "1": 1, "2": 1, "3": 1 },
    now: NOW
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.newEventIds, ["2"]);
  assert.deepEqual(result.overlapEventIds, ["1"]);
});

test("returns no work when event IDs and revisions are already checkpointed", () => {
  const result = selectCheckpointInput({
    events: [event(1, 20), event(2, 15)],
    latestCheckpoint: { lastEventId: "2" },
    includedRevisions: { "1": 1, "2": 1 },
    now: NOW
  });
  assert.deepEqual(result, { eligible: false, reason: "no_changes" });
});
