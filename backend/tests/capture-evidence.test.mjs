import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCaptureBatch } from '../src/validation.js';
import { captureEvidenceFor, observationWarnings } from '../src/capture-evidence.js';
import { activityFromEvents, orderTranscriptEvents, transcriptCoverage } from '../src/conversation-activity.js';
import { validBatchV2 } from './fixtures.mjs';

export const evidence = { version: 1, conversationIdentity: 'local_session', messageIdentity: 'local_sequence',
  timestampBasis: 'observed', orderBasis: 'session_sequence', completeness: 'unknown', titleBasis: 'placeholder' };
function nativeBatch() {
  const batch = validBatchV2({ surface: 'android', reason: 'accessibility' });
  batch.captureClient.type = 'accessibility';
  batch.captureClient.os = 'android';
  batch.coverage = { state: 'partial', gapBefore: true, backfillAvailable: false };
  Object.assign(batch.events[0], { conversationId: 'android-session:local-test', sourceLocator: 'android-session:local-test',
    providerMessageId: null, messageTimestamp: null, sourceUrl: null, captureEvidence: { ...evidence } });
  return batch;
}
test('native evidence survives validation and unknown source dates stay null', () => {
  const result = validateCaptureBatch(nativeBatch());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.value.events[0].captureEvidence, evidence);
  assert.equal(result.value.events[0].messageTimestamp, null);
  assert.equal(Object.hasOwn(validateCaptureBatch(validBatchV2()).value.events[0], 'captureEvidence'), false);
});
test('malformed evidence and contradictions cannot assert provider facts', () => {
  for (const patch of [{ version: 99 }, { completeness: 'complete' }, { timestampBasis: 'source' }, { instructions: 'untrusted' }]) {
    const batch = nativeBatch(); Object.assign(batch.events[0].captureEvidence, patch);
    assert.equal(validateCaptureBatch(batch).ok, false);
  }
  for (const patch of [{ messageTimestamp: '2020-01-01T00:00:00Z' }, { providerMessageId: 'provider-id' }, { sourceLocator: 'other' }]) {
    const batch = nativeBatch(); Object.assign(batch.events[0], patch);
    assert.equal(validateCaptureBatch(batch).ok, false);
  }
});
test('legacy mobile snapshots are conservatively described without upgrading their identity', () => {
  const old = { source_locator: 'android-chatgpt:test' };
  assert.equal(captureEvidenceFor(old).conversationIdentity, 'local_snapshot');
  assert.equal(captureEvidenceFor(old).completeness, 'unknown');
  assert.ok(observationWarnings(old).some(text => text.includes('Original message date unknown')));
});
test('scrolling up later preserves local session order without creating original timestamps', () => {
  const events = [
    { id: 1, sequence: 500000, captured_at: '2026-10-02T06:00:00Z', source_locator: 'android-session:test', capture_evidence: evidence },
    { id: 2, sequence: 499999, captured_at: '2026-10-02T06:05:00Z', source_locator: 'android-session:test', capture_evidence: evidence }
  ];
  assert.deepEqual(orderTranscriptEvents(events).map(e => e.id), [2, 1]);
  assert.equal(activityFromEvents({ last_captured_at: events[1].captured_at }, events).last_activity_basis, 'first_captured_message');
  const coverage = transcriptCoverage({ coverage_state: 'partial' }, events);
  assert.equal(coverage.status, 'partial_or_uncertain');
  assert.equal(coverage.reasons.length, new Set(coverage.reasons).size);
});
