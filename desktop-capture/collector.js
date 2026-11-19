import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { readCodexSession } from "./codex.js";
import { createCodexBatches, createCodexBatchTemplate } from "./batches.js";
import { validateCaptureBatch } from "../backend/src/validation.js";
import { recordCapturedBatch } from "./capture-log.js";

import { readCodexTitles, codexSourceTitle, applyDisplayTitle, rememberConversationMetadata, queueConversationTitle } from "./source-metadata.js";

export const MAX_PENDING_BATCHES = 100;
export const MAX_PENDING_BYTES = 20 * 1024 * 1024;

export async function discoverSessionFiles(root) {
  const files = [];
  async function walk(directory, depth) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  await walk(root, 0);
  return files.sort();
}

export async function isUserOwnedSessionFile(filename) {
  const stream = createReadStream(filename, { encoding: "utf8", highWaterMark: 16 * 1024 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 512_000) throw new Error("Codex session header exceeds the supported size.");
      let first;
      try { first = JSON.parse(line); }
      catch { throw new Error("Codex session header is not complete JSON."); }
      return first?.type === "session_meta" && first.payload?.thread_source === "user"
        && typeof first.payload?.source === "string";
    }
    throw new Error("Codex session is empty.");
  } finally {
    lines.close();
    stream.destroy();
  }
}

function pendingBytes(pending) {
  return Buffer.byteLength(JSON.stringify(pending));
}

export async function collectCodexChanges(state, store, {
  sessionsDir, workspaceId, deviceId, surface = "desktop", captureFrom,
  now = () => new Date().toISOString(), maxPendingBatches = MAX_PENDING_BATCHES,
  maxPendingBytes = MAX_PENDING_BYTES, isEnabled = async () => true,
  files = null, metadataDatabase = null, serverCapabilities = {}, ignoreFingerprint = false, reason = "hook"
}) {
  if (!(await isEnabled())) return { addedEvents: 0, addedUpdates: 0, skippedFiles: 0, queueFull: false, incompleteRows: 0, readFailures: 0, pendingBatches: state.pending.length };
  const nativeTitles = await readCodexTitles(sessionsDir, metadataDatabase);
  let addedEvents = 0;
  let addedUpdates = 0;
  let skippedFiles = 0;
  let queueFull = false;
  let incompleteRows = 0;
  let readFailures = 0;
  for (const filename of files || await discoverSessionFiles(sessionsDir)) {
    if (!(await isEnabled())) break;
    let metadata;
    try { metadata = await stat(filename); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const fingerprint = `${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
    const nativeRecord = [...nativeTitles.values()].find((row) => typeof row.rollout_path === "string" && resolve(row.rollout_path) === resolve(filename));
    const titleFingerprint = JSON.stringify([codexSourceTitle(nativeRecord, filename), serverCapabilities.sourceMetadataVersion, serverCapabilities.conversationUpdatesVersion]);
    if (!ignoreFingerprint && state.fingerprints[filename] === fingerprint
        && state.metadataFingerprints?.[filename] === titleFingerprint) continue;
    let userOwned;
    try { userOwned = await isUserOwnedSessionFile(filename); }
    catch (error) {
      readFailures += 1;
      state.lastError = `Could not read a Codex session header: ${error.message}`;
      continue;
    }
    if (!userOwned) {
      state.fingerprints[filename] = fingerprint;
      skippedFiles += 1;
      continue;
    }
    let parsed;
    try { parsed = await readCodexSession(filename); }
    catch (error) {
      readFailures += 1;
      state.lastError = `Could not parse an eligible Codex session: ${error.message}`;
      continue;
    }
    incompleteRows += parsed.diagnostics.malformedRows + parsed.diagnostics.oversizedMessages + parsed.diagnostics.oversizedRows;
    if (parsed.diagnostics.malformedRows > 0 || parsed.diagnostics.oversizedMessages > 0 || parsed.diagnostics.oversizedRows > 0) {
      state.lastError = `Codex session has ${parsed.diagnostics.malformedRows} malformed row(s) and ${parsed.diagnostics.oversizedMessages} oversized message(s), ${parsed.diagnostics.oversizedRows} oversized log record(s); source files remain available and coverage is incomplete.`;
    }
    const eligible = parsed.events.filter((event) =>
      Date.parse(event.messageTimestamp) >= Date.parse(captureFrom));
    const nativeTitle = codexSourceTitle(nativeTitles.get(parsed.sessionId), filename);
    const titled = applyDisplayTitle(eligible, nativeTitle,
      `Codex session ${parsed.sessionId.slice(0, 8)}`);
    const changed = titled.filter((event) => state.seen[event.eventId] !== event.contentHash);
    if (!changed.length) {
      if (!(await isEnabled())) break;
      // A resumed capture boundary limits messages, not a proven existing chat title.
      const template = createCodexBatchTemplate(parsed, { workspaceId, deviceId, surface,
        capturedAt: now(), reason });
      const update = queueConversationTitle(state, template, parsed.sessionId, nativeTitle, serverCapabilities, { maxPendingBatches, maxPendingBytes });
      if (update === "full") { queueFull = true; state.lastError = "Encrypted capture queue is full; title update will retry."; break; }
      if (update === "queued") addedUpdates++;
      (state.metadataFingerprints ||= {})[filename] = titleFingerprint;
      if (parsed.diagnostics.malformedRows === 0 && parsed.diagnostics.oversizedMessages === 0 && parsed.diagnostics.oversizedRows === 0) {
        state.fingerprints[filename] = fingerprint;
      }
      continue;
    }
    let batches;
    try { batches = createCodexBatches({ ...parsed, events: changed }, {
      workspaceId, deviceId, surface, capturedAt: now(), reason, serverCapabilities,
      gapBefore: parsed.events.length > eligible.length || parsed.diagnostics.oversizedRows > 0
    }); }
    catch (error) {
      state.lastError = `Could not package a Codex session: ${error.message}`;
      continue;
    }
    for (const batch of batches) {
      if (!(await isEnabled())) break;
      const validation = validateCaptureBatch(batch);
      if (!validation.ok) {
        state.lastError = `Capture batch failed validation: ${validation.errors[0]?.path || "unknown field"}`;
        break;
      }
      const candidate = [...state.pending, { batch, attempts: 0, nextAttemptAt: null }];
      if (candidate.length > maxPendingBatches || pendingBytes(candidate) > maxPendingBytes) {
        queueFull = true;
        state.lastError = "Encrypted capture queue is full; session files remain available for retry.";
        break;
      }
      state.pending = candidate;
      recordCapturedBatch(state, batch);
      rememberConversationMetadata(state, batch);
      for (const event of batch.events) {
        state.seen[event.eventId] = event.contentHash;
        addedEvents += 1;
      }
      state.lastCaptureAt = now();
      await store.save(state);
    }
    if (queueFull) break;
    // Save the fingerprint only after all eligible changes entered the queue.
    if (parsed.diagnostics.malformedRows === 0 && parsed.diagnostics.oversizedMessages === 0 && parsed.diagnostics.oversizedRows === 0
      && batches.every((batch) => batch.events.every((event) => state.seen[event.eventId] === event.contentHash))) {
      state.fingerprints[filename] = fingerprint;
      (state.metadataFingerprints ||= {})[filename] = titleFingerprint;
    }
  }
  await store.save(state);
  return { addedEvents, addedUpdates, skippedFiles, queueFull, incompleteRows, readFailures, pendingBatches: state.pending.length };
}
