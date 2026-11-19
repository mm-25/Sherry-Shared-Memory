import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_STATE = Object.freeze({
  version: 1,
  workspaceId: null,
  seen: {},
  fingerprints: {},
  metadataFingerprints: {},
  conversationMetadata: {},
  chatgptIdentities: [],
  claudeIdentities: [],
  sourceStats: {},
  recentCaptures: [],
  sourceChecks: {},
  connection: null,
  pending: [],
  quarantined: [],
  lastCaptureAt: null,
  lastUploadAt: null,
  lastError: null
});

export class EncryptedStateStore {
  constructor(directory, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Queue key must be 32 bytes.");
    this.directory = directory;
    this.filename = join(directory, "queue.json.enc");
    this.key = key;
  }

  async load() {
    let bytes;
    try { bytes = await readFile(this.filename, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") return structuredClone(DEFAULT_STATE);
      throw error;
    }
    const envelope = JSON.parse(bytes);
    if (envelope.version !== 1 || typeof envelope.iv !== "string"
      || typeof envelope.tag !== "string" || typeof envelope.ciphertext !== "string") {
      throw new Error("The encrypted queue has an unsupported format.");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final()
    ]);
    const state = JSON.parse(plaintext.toString("utf8"));
    if (state.version !== 1 || !Array.isArray(state.pending) || !Array.isArray(state.quarantined)
      || !state.seen || typeof state.seen !== "object"
      || !state.fingerprints || typeof state.fingerprints !== "object"
      || (state.metadataFingerprints !== undefined && (!state.metadataFingerprints || typeof state.metadataFingerprints !== "object" || Array.isArray(state.metadataFingerprints)))
      || (state.conversationMetadata !== undefined && (!state.conversationMetadata || typeof state.conversationMetadata !== "object" || Array.isArray(state.conversationMetadata)))
      || (state.chatgptIdentities !== undefined && !Array.isArray(state.chatgptIdentities))
      || (state.claudeIdentities !== undefined && !Array.isArray(state.claudeIdentities))
      || (state.recentCaptures !== undefined && !Array.isArray(state.recentCaptures))
      || (state.sourceStats !== undefined && (typeof state.sourceStats !== "object" || Array.isArray(state.sourceStats)))
      || (state.connection !== undefined && state.connection !== null
        && (typeof state.connection !== "object" || typeof state.connection.accessToken !== "string"))
      || (state.workspaceId !== undefined && state.workspaceId !== null
        && typeof state.workspaceId !== "string")) {
      throw new Error("The decrypted queue has an unsupported format.");
    }
    return state;
  }

  async save(state) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    });
    const temporary = join(this.directory, `.queue-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, envelope, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.filename);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export function bindWorkspace(state, workspaceId) {
  if (!workspaceId) throw new Error("SHERRY_WORKSPACE_ID is required before capture can start.");
  const queuedIds = [...state.pending, ...state.quarantined]
    .map((item) => item.batch?.workspaceId).filter(Boolean);
  const knownIds = new Set([state.workspaceId, ...queuedIds].filter(Boolean));
  if (knownIds.size > 1 || (knownIds.size === 1 && !knownIds.has(workspaceId))) {
    throw new Error("Encrypted desktop capture belongs to another workspace. Keep its queue and use a separate SHERRY_CAPTURE_HOME for this workspace.");
  }
  if (knownIds.size === 0 && (Object.keys(state.seen).length || Object.keys(state.fingerprints).length
      || state.chatgptIdentities?.length || state.claudeIdentities?.length)) {
    throw new Error("The existing capture state has no workspace identity. Use a separate SHERRY_CAPTURE_HOME to avoid losing deduplication history.");
  }
  state.workspaceId = workspaceId;
}
