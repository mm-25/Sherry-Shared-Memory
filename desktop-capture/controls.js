import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

async function atomicJson(filename, value) {
  const directory = filename.slice(0, filename.lastIndexOf("/"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.control-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readControls(directory) {
  try {
    const value = JSON.parse(await readFile(join(directory, "controls.json"), "utf8"));
    if (value.version === 1 && typeof value.paused === "boolean"
      && typeof value.captureFrom === "string" && Number.isFinite(Date.parse(value.captureFrom))) {
      return { ...value, sources: {
        codex: value.sources?.codex || { enabled: true, captureFrom: value.captureFrom },
        // Existing installations may have enabled the shared-shell reader.
        // It cannot distinguish ChatGPT from Codex, so never run it.
        chatgpt: { ...(value.sources?.chatgpt || { captureFrom: value.captureFrom }), enabled: false },
        claude: value.sources?.claude || { enabled: false, captureFrom: value.captureFrom },
        antigravity: value.sources?.antigravity || { enabled: false, captureFrom: value.captureFrom }
      } };
    }
    throw new Error("Invalid desktop capture controls.");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function setCapturePaused(directory, paused, now = new Date().toISOString()) {
  const existing = await readControls(directory);
  const value = {
    version: 1,
    paused,
    // Resume deliberately starts from now. Conversations created while paused
    // are not read retroactively unless the user explicitly requests backfill.
    captureFrom: paused || existing?.paused === false ? (existing?.captureFrom || now) : now,
    sources: existing?.sources || {
      codex: { enabled: true, captureFrom: now },
      chatgpt: { enabled: false, captureFrom: now },
      claude: { enabled: false, captureFrom: now },
      antigravity: { enabled: false, captureFrom: now }
    },
    updatedAt: now
  };
  await atomicJson(join(directory, "controls.json"), value);
  return value;
}

export async function setSourceEnabled(directory, source, enabled, now = new Date().toISOString()) {
  if (!["codex", "chatgpt", "claude", "antigravity"].includes(source)) throw new Error("Unsupported desktop capture source.");
  if (source === "chatgpt" && enabled) {
    throw new Error("ChatGPT desktop capture is unavailable: this app cannot yet separate ChatGPT from Codex. Use the browser extension for ChatGPT.");
  }
  const controls = await readControls(directory) || await setCapturePaused(directory, true, now);
  const value = { ...controls, sources: { ...controls.sources,
    [source]: { enabled, captureFrom: enabled && !controls.sources[source].enabled
      ? now : controls.sources[source].captureFrom } }, updatedAt: now };
  await atomicJson(join(directory, "controls.json"), value);
  return value;
}

export async function isSourceActive(directory, source, captureFrom) {
  const controls = await readControls(directory);
  return Boolean(controls && !controls.paused && controls.sources[source]?.enabled
    && controls.sources[source].captureFrom === captureFrom);
}

export async function isCaptureEpochActive(directory, captureFrom) {
  const controls = await readControls(directory);
  return Boolean(controls && !controls.paused && controls.captureFrom === captureFrom);
}

export async function writeStatus(directory, status) {
  await atomicJson(join(directory, "status.json"), status);
}

export async function readStatus(directory) {
  try { return JSON.parse(await readFile(join(directory, "status.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
