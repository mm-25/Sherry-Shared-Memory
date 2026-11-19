import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { MAX_PENDING_BATCHES, MAX_PENDING_BYTES } from "./collector.js";
import { readAntigravityTranscript, createAntigravityBatches, createAntigravityBatchTemplate } from "./antigravity.js";
import { validateCaptureBatch } from "../backend/src/validation.js";
import { recordCapturedBatch } from "./capture-log.js";

import { readAntigravityTitles, antigravitySourceTitle, applyDisplayTitle, rememberConversationMetadata, queueConversationTitle } from "./source-metadata.js";

export async function collectAntigravityChanges(state, store, {
  root = join(homedir(), ".gemini", "antigravity", "brain"), workspaceId, deviceId,
  captureFrom, serverCapabilities = {}, isEnabled = async () => true,
  now = () => new Date().toISOString()
}) {
  if (!(await isEnabled())) return { addedEvents: 0, addedUpdates: 0, pendingBatches: state.pending.length };
  let folders;
  try { folders = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { addedEvents: 0 }; throw error; }
  const nativeTitles = await readAntigravityTitles(root);
  let addedEvents = 0;
  let addedUpdates = 0;
  for (const folder of folders) {
    if (!(await isEnabled())) break;
    if (!folder.isDirectory() || !/^[0-9a-f-]{36}$/i.test(folder.name)) continue;
    const filename = join(root, folder.name, ".system_generated", "logs", "transcript.jsonl");
    let metadata;
    try { metadata = await stat(filename); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const fingerprint = `${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
    const key = `antigravity:${filename}`;
    const nativeTitle = antigravitySourceTitle(nativeTitles.get(folder.name));
    const titleFingerprint = JSON.stringify([nativeTitle, serverCapabilities.sourceMetadataVersion, serverCapabilities.conversationUpdatesVersion]);
    if (state.fingerprints[key] === fingerprint && state.metadataFingerprints?.[key] === titleFingerprint) continue;
    let parsed;
    try { parsed = await readAntigravityTranscript(filename, folder.name); }
    catch (error) { state.lastError = `Antigravity transcript could not be read: ${error.message}`; continue; }
    const eligible = parsed.events.filter((event) => Date.parse(event.messageTimestamp) >= Date.parse(captureFrom));
    const titled = applyDisplayTitle(eligible, nativeTitle,
      `Antigravity conversation ${parsed.conversationId.slice(0, 8)}`);
    const changed = titled.filter((event) => state.seen[event.eventId] !== event.contentHash);
    if (!changed.length) {
      if (!(await isEnabled())) break;
      // A resumed capture boundary limits messages, not a proven existing chat title.
      const template = createAntigravityBatchTemplate(parsed, { workspaceId, deviceId, capturedAt: now() });
      const update = queueConversationTitle(state, template, parsed.conversationId, nativeTitle, serverCapabilities);
      if (update === "full") { state.lastError = "Encrypted capture queue is full; Antigravity title will retry."; break; }
      if (update === "queued") addedUpdates++;
      state.fingerprints[key] = fingerprint;
      (state.metadataFingerprints ||= {})[key] = titleFingerprint;
      continue;
    }
    let batches;
    try { batches = createAntigravityBatches({ ...parsed, events: changed }, { workspaceId, deviceId,
      capturedAt: now(), serverCapabilities, gapBefore: eligible.length < parsed.events.length }); }
    catch (error) { state.lastError = `Antigravity transcript could not be packaged: ${error.message}`; continue; }
    let complete = true;
    for (const batch of batches) {
      if (!(await isEnabled())) { complete = false; break; }
      const valid = validateCaptureBatch(batch);
      if (!valid.ok) { state.lastError = `Antigravity batch invalid: ${valid.errors[0]?.path}`; complete = false; break; }
      const candidate = [...state.pending, { batch, attempts: 0, nextAttemptAt: null }];
      if (candidate.length > MAX_PENDING_BATCHES || Buffer.byteLength(JSON.stringify(candidate)) > MAX_PENDING_BYTES) {
        state.lastError = "Encrypted capture queue is full; Antigravity will retry.";
        complete = false; break;
      }
      state.pending = candidate;
      recordCapturedBatch(state, batch);
      rememberConversationMetadata(state, batch);
      for (const event of batch.events) { state.seen[event.eventId] = event.contentHash; addedEvents++; }
      state.lastCaptureAt = now();
      await store.save(state);
    }
    if (complete) { state.fingerprints[key] = fingerprint; (state.metadataFingerprints ||= {})[key] = titleFingerprint; }
  }
  await store.save(state);
  return { addedEvents, addedUpdates, pendingBatches: state.pending.length };
}
