import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { validateCaptureBatch } from '../../backend/src/validation.js';

const fixtures = JSON.parse(await readFile(new URL('../core/build/contract-fixtures.json', import.meta.url), 'utf8'));
assert.equal(fixtures.length, 3);
for (const fixture of fixtures) {
  const result = validateCaptureBatch(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.surface, 'android');
  assert.equal(result.value.captureClient.type, 'share');
  assert.equal(result.value.coverage.state, 'partial');
  assert.equal(result.value.events[0].role, 'unknown');
  assert.deepEqual(result.value.events[0].sourceMetadata, fixture.events[0].sourceMetadata);
  assert.equal(result.value.events[0].sourceMetadata.titleBasis, 'user');
}
console.log('All three Kotlin-generated Android envelopes pass the existing Sherry backend validator.');

const native = JSON.parse(await readFile(new URL('../core/build/native-contract-fixtures.json', import.meta.url), 'utf8'));
assert.equal(native.length, 3);
for (const fixture of native) {
  const result = validateCaptureBatch(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.captureClient.type, 'accessibility');
  assert.equal(result.value.coverage.state, 'partial');
  assert.deepEqual(result.value.events[0].sourceMetadata, fixture.events[0].sourceMetadata);
  assert.equal(result.value.events[0].sourceMetadata.titleBasis, 'generic');
}
assert.deepEqual(native.map(batch => batch.events[0].role), ['user', 'assistant', 'user']);
console.log('Three native message envelopes also pass the existing backend validator.');

const session = JSON.parse(await readFile(new URL('../core/build/session-contract-fixtures.json', import.meta.url), 'utf8'));
assert.equal(session.length, 4);
for (const fixture of session) {
  const result = validateCaptureBatch(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.value.events[0].captureEvidence, fixture.events[0].captureEvidence);
  assert.deepEqual(result.value.events[0].sourceMetadata, fixture.events[0].sourceMetadata);
  assert.equal(result.value.events[0].sourceMetadata.titleBasis, 'generic');
  assert.equal(result.value.events[0].messageTimestamp, null);
}
assert.equal(new Set(session.map(batch => batch.events[0].conversationId)).size, 1);
assert.equal(new Set(session.map(batch => batch.events[0].eventId)).size, 4);
console.log('Four reconciled native turns preserve their evidence through the backend validator.');
