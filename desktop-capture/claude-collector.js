import { stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { discoverSessionFiles, MAX_PENDING_BATCHES, MAX_PENDING_BYTES } from "./collector.js";
import { readClaudeCodeSession, createClaudeCodeBatches } from "./claude-code.js";
import { validateCaptureBatch } from "../backend/src/validation.js";

export async function collectClaudeCodeChanges(state, store, {
  root = join(homedir(), ".claude", "projects"), workspaceId, deviceId,
  captureFrom, isEnabled = async () => true,
  now = () => new Date().toISOString()
}) {
  let addedEvents = 0;
  for (const filename of await discoverSessionFiles(root)) {
    if (!(await isEnabled())) break;
    if (filename.includes("/subagents/")) continue;
    let metadata;
    try { metadata = await stat(filename); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const fingerprint = `${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
    const key = `claude:${filename}`;
    if (state.fingerprints[key] === fingerprint) continue;
    let parsed;
    try { parsed = await readClaudeCodeSession(filename); }
    catch (error) {
      if (error.message === "No user-owned Claude Code session was found.") {
        state.fingerprints[key] = fingerprint;
        continue;
      }
      state.lastError = `Claude Code session could not be read: ${error.message}`;
      continue;
    }
    const eligible = parsed.events.filter((event) => Date.parse(event.messageTimestamp) >= Date.parse(captureFrom));
    const title = eligible.find((event) => event.role === "user")?.text.split("\n")[0].slice(0, 160)
      || `Claude Code session ${parsed.sessionId.slice(0, 8)}`;
    const changed = eligible.filter((event) => state.seen[event.eventId] !== event.contentHash)
      .map((event) => ({ ...event, chatTitle: title }));
    if (!changed.length) { state.fingerprints[key] = fingerprint; continue; }
    let batches;
    try { batches = createClaudeCodeBatches({ ...parsed, events: changed }, { workspaceId, deviceId,
      capturedAt: now(), gapBefore: eligible.length < parsed.events.length }); }
    catch (error) { state.lastError = `Claude Code session could not be packaged: ${error.message}`; continue; }
    let complete = true;
    for (const batch of batches) {
      if (!(await isEnabled())) { complete = false; break; }
      const valid = validateCaptureBatch(batch);
      if (!valid.ok) { state.lastError = `Claude Code batch invalid: ${valid.errors[0]?.path}`; complete = false; break; }
      const candidate = [...state.pending, { batch, attempts: 0, nextAttemptAt: null }];
      if (candidate.length > MAX_PENDING_BATCHES || Buffer.byteLength(JSON.stringify(candidate)) > MAX_PENDING_BYTES) {
        state.lastError = "Encrypted capture queue is full; Claude Code will retry.";
        complete = false; break;
      }
      state.pending = candidate;
      for (const event of batch.events) { state.seen[event.eventId] = event.contentHash; addedEvents++; }
      state.lastCaptureAt = now();
      await store.save(state);
    }
    if (complete) state.fingerprints[key] = fingerprint;
  }
  await store.save(state);
  return { addedEvents, pendingBatches: state.pending.length };
}
