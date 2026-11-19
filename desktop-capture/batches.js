import { createHash } from "node:crypto";
import { hostname, platform, userInfo } from "node:os";

import { eventForServer } from "./source-metadata.js";

const MAX_BATCH_BYTES = 450_000;
const MAX_EVENTS = 100;

function sha(value) { return createHash("sha256").update(value).digest("hex"); }

export function stableUuid(value) {
  const hex = sha(value).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = "8";
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

export function localDeviceId() {
  return `device_${sha(`${hostname()}\0${userInfo().uid}`).slice(0, 32)}`;
}

export function createCodexBatchTemplate(parsed, {
  workspaceId, deviceId = localDeviceId(), surface = "desktop",
  capturedAt = new Date().toISOString(), gapBefore = false, reason = "hook"
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId || "")) {
    throw new Error("SHERRY_WORKSPACE_ID must be a UUID.");
  }
  if (!["desktop", "cli", "ide"].includes(surface)) throw new Error("Unsupported Codex surface.");
  if (!["hook", "manual", "initial_backfill", "repair_backfill"].includes(reason)) {
    throw new Error("Unsupported Codex capture reason.");
  }
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("Capture time must be an ISO timestamp.");
  const os = platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux";
  return {
    schemaVersion: 2,
    workspaceId,
    provider: "codex",
    providerFamily: "openai",
    product: "codex",
    surface,
    reason,
    clientCreatedAt: capturedAt,
    captureClient: {
      type: "structured_hook",
      adapterVersion: "codex-jsonl-poc-0.1.0",
      deviceId,
      os,
      appVersion: parsed.appVersion,
      captureSessionId: parsed.sessionId
    },
    coverage: {
      state: "partial",
      gapBefore: gapBefore || parsed.diagnostics.malformedRows > 0 || parsed.diagnostics.oversizedMessages > 0,
      backfillAvailable: true
    },
  };
}

export function createCodexBatches(parsed, {
  capturedAt = new Date().toISOString(), serverCapabilities = {}, ...options
}) {
  const template = createCodexBatchTemplate(parsed, { ...options, capturedAt });
  const batches = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const basis = { ...template, events: pending };
    batches.push({ ...basis, batchId: stableUuid(JSON.stringify(basis)) });
    pending = [];
  };
  for (const sourceEvent of parsed.events) {
    const event = { ...eventForServer(sourceEvent, serverCapabilities), capturedAt };
    const candidate = [...pending, event];
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_BATCH_BYTES) {
      if (!pending.length) throw new Error(`Codex message ${event.providerMessageId} is too large for one batch.`);
      flush();
    }
    pending.push(event);
    if (pending.length >= MAX_EVENTS) flush();
  }
  flush();
  return batches;
}
