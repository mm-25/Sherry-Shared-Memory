import { execFile } from "node:child_process";
import { open, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { localDeviceId } from "./batches.js";
import { collectChatGptSnapshot } from "./chatgpt-collector.js";
import { parseChatGptAxSnapshot } from "./chatgpt-ax.js";
import { collectCodexChanges } from "./collector.js";
import { collectClaudeDesktopSnapshot } from "./claude-desktop-collector.js";
import { parseClaudeAxSnapshot } from "./claude-desktop.js";
import { collectAntigravityChanges } from "./antigravity-collector.js";
import { isCaptureEpochActive, isSourceActive, readControls, readStatus, setCapturePaused, setSourceEnabled, writeStatus } from "./controls.js";
import { refreshConnection, validateConnection, WORKER_URL } from "./connection.js";
import { bindWorkspace, EncryptedStateStore } from "./state.js";
import { uploadPending } from "./uploader.js";
import { captureLogView } from "./capture-log.js";
import { createSnapshotBridge } from "./native-snapshot.js";

import { captureServerCapabilities } from "./source-metadata.js";

const execFileAsync = promisify(execFile);
const moduleDir = fileURLToPath(new URL(".", import.meta.url));
let lastChatGptPollAt = 0;
let lastClaudePollAt = 0;
let nativeSnapshots = null;

export function defaultCaptureHome() {
  return process.env.SHERRY_CAPTURE_HOME
    || join(homedir(), "Library", "Application Support", "Sherry", "DesktopCapture");
}

export async function macKeychainKey() {
  const helper = join(moduleDir, ".build", "keychain_key");
  let stdout;
  try {
    ({ stdout } = await execFileAsync(helper, [], { timeout: 60_000, maxBuffer: 256 }));
  } catch (error) {
    const detail = String(error.stderr || "").trim();
    throw new Error(`Keychain queue key is unavailable${detail ? `: ${detail}` : ` (${error.code || "unknown error"})`}.`);
  }
  const hex = stdout.trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("Keychain helper returned an invalid queue key.");
  return Buffer.from(hex, "hex");
}

export function serviceConfig() {
  return {
    home: defaultCaptureHome(),
    sessionsDir: process.env.SHERRY_CODEX_SESSIONS_DIR || join(homedir(), ".codex", "sessions"),
    workspaceId: process.env.SHERRY_WORKSPACE_ID,
    deviceId: process.env.SHERRY_DEVICE_ID || localDeviceId(),
    surface: process.env.SHERRY_CODEX_SURFACE || "desktop",
    endpoint: process.env.SHERRY_INGESTION_URL,
    accessToken: process.env.SHERRY_ACCESS_TOKEN
  };
}

async function ensureControls(home) {
  const controls = await readControls(home);
  if (controls) return controls;
  return setCapturePaused(home, true);
}

function summary(state, controls, config, running) {
  return {
    running,
    pid: running ? process.pid : null,
    paused: controls.paused,
    captureFrom: controls.captureFrom,
    sources: controls.sources,
    sourceStats: state.sourceStats || {},
    pendingBatches: state.pending.length,
    quarantinedBatches: state.quarantined.length,
    lastCaptureAt: state.lastCaptureAt,
    lastUploadAt: state.lastUploadAt,
    lastError: state.lastError,
    connectionConfigured: Boolean(state.connection || (config.endpoint && config.accessToken)),
    accountEmail: state.connection?.email || null,
    workspaceName: state.connection?.workspaceName || null,
    heartbeatAt: new Date().toISOString()
  };
}

export async function runCaptureCycle(config, store, { running = false } = {}) {
  const controls = await ensureControls(config.home);
  const state = await store.load();
  if (!controls.paused) {
    const workspaceId = state.connection?.workspaceId || config.workspaceId;
    if (!workspaceId) {
      state.lastError = "SHERRY_WORKSPACE_ID is required before capture can start.";
      await store.save(state);
    } else {
      bindWorkspace(state, workspaceId);
      await store.save(state);
      const serverCapabilities = await captureServerCapabilities(config.endpoint || (state.connection ? WORKER_URL : null));
      const record = async (source, result) => {
        const prefix = source === "claude" ? "Claude desktop capture:" : "ChatGPT capture:";
        if (["claude", "chatgpt"].includes(source) && state.lastError?.startsWith(prefix)) state.lastError = null;
        if (source === "codex" && !result?.readFailures && !result?.incompleteRows
          && /^(Could not (?:read a Codex|parse an eligible Codex)|Codex session has)/.test(state.lastError || "")) state.lastError = null;
        state.sourceChecks ||= {};
        const incomplete = Boolean(result?.readFailures || result?.incompleteRows);
        state.sourceChecks[source] = { checkedAt: new Date().toISOString(),
          status: result?.codeView || incomplete ? "waiting" : "ready",
          message: incomplete ? `${result.readFailures || 0} log file(s) could not be read; ${result.incompleteRows || 0} record(s) need review. Source files remain available.`
            : result?.codeView ? "Switch from Claude Code to an ordinary Claude chat."
            : result?.addedEvents ? `${result.addedEvents} new or updated turns captured.`
              : result?.addedUpdates ? `${result.addedUpdates} conversation title update(s) captured.`
              : "Scan completed. No new turns found." };
        await store.save(state);
        if (!result?.addedEvents) return;
        const stats = state.sourceStats ||= {};
        stats[source] = { capturedEvents: (stats[source]?.capturedEvents || 0) + result.addedEvents,
          lastCapturedAt: new Date().toISOString() };
        await store.save(state);
      };
      const readerError = async (source, error) => {
        const prefix = source === "claude" ? "Claude desktop capture:" : "ChatGPT capture:";
        // Replace an old permission error with the current source result, rather
        // than displaying it forever after permission has already recovered.
        if (state.lastError?.startsWith(prefix)) state.lastError = null;
        state.sourceChecks ||= {};
        state.sourceChecks[source] = { checkedAt: new Date().toISOString(), status: "waiting",
          message: error.message.slice(0, 400) };
        await store.save(state);
      };
      if (controls.sources.codex.enabled) await record("codex", await collectCodexChanges(state, store, {
        sessionsDir: config.sessionsDir, serverCapabilities,
        workspaceId,
        deviceId: config.deviceId,
        surface: config.surface,
        captureFrom: new Date(Math.max(Date.parse(controls.captureFrom),
          Date.parse(controls.sources.codex.captureFrom))).toISOString(),
        isEnabled: async () => isCaptureEpochActive(config.home, controls.captureFrom)
          && isSourceActive(config.home, "codex", controls.sources.codex.captureFrom)
      }));
      // MVP Claude switch covers the visible desktop chat. The separate Code
      // parser remains available for later work without importing console history.
      if (controls.sources.claude.enabled && Date.now() - lastClaudePollAt >= 5000
          && await isSourceActive(config.home, "claude", controls.sources.claude.captureFrom)) {
        lastClaudePollAt = Date.now();
        try {
          const raw = await readClaudeSnapshot();
          await record("claude", await collectClaudeDesktopSnapshot(state, store, raw, { workspaceId, deviceId: config.deviceId, serverCapabilities,
            isEnabled: async () => isCaptureEpochActive(config.home, controls.captureFrom)
              && isSourceActive(config.home, "claude", controls.sources.claude.captureFrom) }));
        } catch (error) {
          await readerError("claude", error);
          if (!/Could not find the main \/Applications\/Claude.app process|No Claude conversation transcript is visible|No verified Claude speaker headings were found|needs a second visible turn/.test(error.message)) {
            state.lastError = `Claude desktop capture: ${error.message.slice(0, 200)}`;
            await store.save(state);
          }
        }
      }
      if (controls.sources.antigravity.enabled) await record("antigravity", await collectAntigravityChanges(state, store, {
        workspaceId, deviceId: config.deviceId, serverCapabilities,
        captureFrom: new Date(Math.max(Date.parse(controls.captureFrom),
          Date.parse(controls.sources.antigravity.captureFrom))).toISOString(),
        isEnabled: async () => isCaptureEpochActive(config.home, controls.captureFrom)
          && isSourceActive(config.home, "antigravity", controls.sources.antigravity.captureFrom)
      }));
      if (controls.sources.chatgpt.enabled && Date.now() - lastChatGptPollAt >= 5000
          && await isSourceActive(config.home, "chatgpt", controls.sources.chatgpt.captureFrom)) {
        lastChatGptPollAt = Date.now();
        try {
          const raw = await readChatGptSnapshot();
          await record("chatgpt", await collectChatGptSnapshot(state, store, raw, { workspaceId, deviceId: config.deviceId, serverCapabilities,
            isEnabled: async () => isCaptureEpochActive(config.home, controls.captureFrom)
              && isSourceActive(config.home, "chatgpt", controls.sources.chatgpt.captureFrom) }));
        } catch (error) {
          await readerError("chatgpt", error);
          if (!/Could not find the main \/Applications\/ChatGPT.app process|No native chat web area is visible|No native chat main area is visible|No ChatGPT transcript is visible|No verified ChatGPT speaker headings were found|needs a second visible turn/.test(error.message)) {
            state.lastError = `ChatGPT capture: ${error.message.slice(0, 200)}`;
            await store.save(state);
          }
        }
      }
      if (await isCaptureEpochActive(config.home, controls.captureFrom)) {
        const connection = await refreshConnection(state, store);
        await uploadPending(state, store, {
          endpoint: config.endpoint || (connection ? WORKER_URL : null),
          accessToken: config.accessToken || connection?.accessToken,
          isEnabled: async () => isCaptureEpochActive(config.home, controls.captureFrom)
        });
      }
    }
  }
  const latestControls = await readControls(config.home);
  const status = summary(state, latestControls, config, running);
  await writeStatus(config.home, status);
  return status;
}

async function acquireLock(home) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const filename = join(home, "service.lock");
  let handle;
  try { handle = await open(filename, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let pid = null;
    try { pid = Number((await readFile(filename, "utf8")).trim()); }
    catch { /* a crashed process may have left an empty lock */ }
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); }
      catch (checkError) {
        if (checkError.code !== "ESRCH") throw checkError;
        pid = null;
      }
    }
    if (pid) throw new Error(`Desktop capture is already running (PID ${pid}).`);
    await rm(filename);
    handle = await open(filename, "wx", 0o600);
  }
  await handle.writeFile(String(process.pid));
  await handle.close();
  return async () => rm(filename, { force: true });
}

async function backfillOneFile(config, store, requestedPath) {
  if (!config.workspaceId) throw new Error("SHERRY_WORKSPACE_ID is required for backfill.");
  const controls = await ensureControls(config.home);
  if (controls.paused) throw new Error("Enable desktop capture before backfilling a session.");
  const root = await realpath(config.sessionsDir);
  const file = await realpath(requestedPath);
  const pathInside = relative(root, file);
  if (!pathInside || pathInside.startsWith(`..${sep}`) || pathInside === ".." || file === root
    || !file.endsWith(".jsonl") || !(await stat(file)).isFile()) {
    throw new Error("Backfill requires one Codex JSONL file inside the configured sessions directory.");
  }
  const state = await store.load();
  bindWorkspace(state, config.workspaceId);
  await store.save(state);
  const result = await collectCodexChanges(state, store, {
    sessionsDir: root,
    workspaceId: config.workspaceId,
    deviceId: config.deviceId,
    surface: config.surface,
    captureFrom: "1970-01-01T00:00:00.000Z",
    files: [file],
    serverCapabilities: await captureServerCapabilities(config.endpoint),
    ignoreFingerprint: true,
    reason: "initial_backfill",
    isEnabled: async () => isCaptureEpochActive(config.home, controls.captureFrom)
  });
  if (await isCaptureEpochActive(config.home, controls.captureFrom)) {
    await uploadPending(state, store, { endpoint: config.endpoint, accessToken: config.accessToken,
      isEnabled: async () => isCaptureEpochActive(config.home, controls.captureFrom) });
  }
  await writeStatus(config.home, summary(state, await readControls(config.home), config, false));
  return result;
}

export async function readChatGptSnapshot() {
  if (nativeSnapshots) return nativeSnapshots.read("chatgpt");
  try {
    const { stdout } = await execFileAsync("sh", [join(moduleDir, "macos", "probe-chatgpt.sh"), "--snapshot"], {
      timeout: 30_000, maxBuffer: 5_000_000
    });
    return stdout;
  } catch (error) {
    const detail = String(error.stderr || "").trim();
    if (error.killed || error.signal) throw new Error("ChatGPT check timed out. Open a ChatGPT conversation and check that Sherry Desktop is enabled in Accessibility settings, then retry.");
    throw new Error(`ChatGPT Accessibility snapshot failed: ${(detail || error.message).trim().slice(0, 300)}`);
  }
}

export async function readClaudeSnapshot() {
  if (nativeSnapshots) return nativeSnapshots.read("claude");
  try {
    const { stdout } = await execFileAsync("sh", [join(moduleDir, "macos", "probe-claude.sh"), "--claude-snapshot"], {
      timeout: 30_000, maxBuffer: 5_000_000
    });
    return stdout;
  } catch (error) {
    const detail = String(error.stderr || "").trim();
    if (error.killed || error.signal) throw new Error("Claude check timed out. Open an ordinary Claude chat and check that Sherry Desktop is enabled in Accessibility settings, then retry.");
    throw new Error(`Claude Accessibility snapshot failed: ${(detail || error.message).trim().slice(0, 300)}`);
  }
}

export async function observeChatGptOnce(config, store, readSnapshot = readChatGptSnapshot) {
  if (process.env.SHERRY_EXPERIMENTAL_CHATGPT_AX !== "1") {
    throw new Error("ChatGPT Accessibility capture is experimental; set SHERRY_EXPERIMENTAL_CHATGPT_AX=1 after verifying this app version.");
  }
  if (!config.workspaceId) throw new Error("SHERRY_WORKSPACE_ID is required for ChatGPT observation.");
  const controls = await ensureControls(config.home);
  if (controls.paused) throw new Error("Enable desktop capture before observing ChatGPT.");
  const state = await store.load();
  bindWorkspace(state, config.workspaceId);
  const rawSnapshot = await readSnapshot();
  const result = await collectChatGptSnapshot(state, store, rawSnapshot, {
    workspaceId: config.workspaceId,
    deviceId: config.deviceId,
    isEnabled: async () => isCaptureEpochActive(config.home, controls.captureFrom)
  });
  if (await isCaptureEpochActive(config.home, controls.captureFrom)) {
    await uploadPending(state, store, { endpoint: config.endpoint, accessToken: config.accessToken,
      isEnabled: async () => isCaptureEpochActive(config.home, controls.captureFrom) });
  }
  await writeStatus(config.home, summary(state, await readControls(config.home), config, false));
  return result;
}

async function main() {
  const command = process.argv[2];
  const config = serviceConfig();
  if (command === "run" && process.env.SHERRY_NATIVE_CAPTURE_PIPE === "1") {
    nativeSnapshots = createSnapshotBridge(process.stdin, process.stdout);
  }
  if (command === "verify") {
    const source = process.argv[3];
    if (!["chatgpt", "claude"].includes(source)) throw new Error("Verify requires chatgpt or claude.");
    let raw;
    if (process.argv.includes("--stdin")) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      raw = Buffer.concat(chunks).toString("utf8");
    } else raw = source === "chatgpt" ? await readChatGptSnapshot() : await readClaudeSnapshot();
    const snapshot = source === "chatgpt" ? parseChatGptAxSnapshot(raw) : parseClaudeAxSnapshot(raw);
    const turns = snapshot.turns;
    console.log(JSON.stringify({ source, surface: snapshot.codeView ? "claude_code" : "desktop_chat", turns: turns.length,
      user: turns.filter((turn) => turn.role === "user").length,
      assistant: turns.filter((turn) => turn.role === "assistant").length,
      textCharacters: turns.reduce((sum, turn) => sum + turn.text.length, 0) }));
    return;
  }
  if (command === "status") {
    const controls = await readControls(config.home);
    const status = await readStatus(config.home);
    const live = status?.running && Date.now() - Date.parse(status.heartbeatAt) < 10_000;
    console.log(JSON.stringify({ ...status, running: Boolean(live), paused: controls?.paused ?? true,
      captureFrom: controls?.captureFrom ?? null, sources: controls?.sources ?? null }, null, 2));
    return;
  }
  if (command === "source") {
    const source = process.argv[3];
    const enabled = process.argv[4] === "on";
    if (!["on", "off"].includes(process.argv[4])) throw new Error("Use source codex|chatgpt|claude|antigravity on|off.");
    await setSourceEnabled(config.home, source, enabled);
    console.log(`${source} capture ${enabled ? "enabled" : "disabled"}.`);
    return;
  }
  if (command === "account" || command === "capture-log") {
    const key = await macKeychainKey();
    try {
      const state = await new EncryptedStateStore(config.home, key).load();
      const source = command === "capture-log" ? process.argv[3] : null;
      if (source && !["codex", "antigravity", "chatgpt", "claude"].includes(source)) throw new Error("Unknown capture log source.");
      const log = command === "capture-log" ? captureLogView(state) : null;
      if (source) log.captures = log.captures.filter((item) => item.source === source);
      console.log(JSON.stringify(command === "capture-log" ? log
        : state.connection ? { email: state.connection.email,
          workspaceId: state.connection.workspaceId, workspaceName: state.connection.workspaceName } : null));
    } finally { key.fill(0); }
    return;
  }
  if (command === "pause" || command === "enable") {
    const controls = await setCapturePaused(config.home, command === "pause");
    console.log(controls.paused ? "Desktop capture paused." : "Desktop capture enabled from now.");
    return;
  }
  if (!["once", "run", "backfill", "observe-chatgpt", "connect", "disconnect"].includes(command)) {
    throw new Error("Usage: node service.js status | enable | pause | source codex|chatgpt|claude|antigravity on|off | verify chatgpt|claude | connect | account | disconnect | once | run | backfill FILE");
  }
  const release = await acquireLock(config.home);
  let key;
  let store;
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  try {
    key = await macKeychainKey();
    store = new EncryptedStateStore(config.home, key);
    if (command === "connect") {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const connection = validateConnection(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const state = await store.load();
      bindWorkspace(state, connection.workspaceId);
      state.connection = connection;
      state.lastError = null;
      await store.save(state);
      console.log("Sherry account connected.");
      return;
    }
    if (command === "disconnect") {
      const state = await store.load();
      state.connection = null;
      await store.save(state);
      await setCapturePaused(config.home, true);
      console.log("Sherry account disconnected; capture paused.");
      return;
    }
    if (command === "backfill") {
      if (!process.argv[3]) throw new Error("Backfill requires a Codex JSONL file path.");
      const result = await backfillOneFile(config, store, process.argv[3]);
      console.log(JSON.stringify(result));
      return;
    }
    if (command === "observe-chatgpt") {
      const result = await observeChatGptOnce(config, store);
      console.log(JSON.stringify(result));
      return;
    }
    do {
      const status = await runCaptureCycle(config, store, { running: command === "run" && !stopping });
      if (!nativeSnapshots) console.log(JSON.stringify({ paused: status.paused, pendingBatches: status.pendingBatches,
        quarantinedBatches: status.quarantinedBatches, lastError: status.lastError }));
      if (command === "once" || stopping) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (!stopping);
  } finally {
    try {
      if (store) {
        const state = await store.load();
        const controls = await ensureControls(config.home);
        await writeStatus(config.home, summary(state, controls, config, false));
      }
    } finally {
      await release();
      key?.fill(0);
      nativeSnapshots?.close();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    nativeSnapshots?.close();
    console.error(error.message);
    process.exitCode = 1;
  });
}
