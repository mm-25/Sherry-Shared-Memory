import { stableUuid } from "./batches.js";
import { validateCaptureBatch } from "../backend/src/validation.js";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
const execute = promisify(execFile);

export function sourceMetadata({ titleBasis = 'unknown', conversationIdentity = 'unknown',
  messageIdentity = 'unknown', timestampBasis = 'unknown' } = {}) {
  return { version: 1, titleBasis, conversationIdentity, messageIdentity, timestampBasis,
    linksStatus: 'not_inspected', attachmentsStatus: 'not_inspected' };
}

// These are native source databases, opened read-only. A source lookup failure
// leaves a classified display fallback; it never prevents preserving new text.
async function rows(database, query) {
  if (!database) return [];
  try {
    const { stdout } = await execute('/usr/bin/sqlite3', ['-readonly', '-json', '-cmd', '.timeout 250', database, query],
      { timeout: 1500, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout || '[]');
  } catch { return []; }
}
export async function readCodexTitles(sessionsDir, database = null) {
  if (!database && sessionsDir) {
    const names = await readdir(dirname(sessionsDir)).catch(() => []);
    const name = names.filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a,b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
    if (name) database = join(dirname(sessionsDir), name);
  }
  let records = await rows(database, 'SELECT id,rollout_path,name,title,first_user_message FROM threads');
  if (!records.length) records = await rows(database, 'SELECT id,rollout_path,title,first_user_message FROM threads');
  return new Map(records.map((row) => [row.id, row]));
}
export async function readAntigravityTitles(root, database = join(dirname(root), 'conversation_summaries.db')) {
  return new Map((await rows(database, 'SELECT conversation_id,title FROM conversation_summaries'))
    .map((row) => [row.conversation_id, row]));
}
function title(value) {
  return typeof value === 'string' && value.trim() && value.trim().length <= 1000 ? value.trim() : null;
}
export function codexSourceTitle(record, filename) {
  if (!record || typeof record.rollout_path !== 'string' || resolve(record.rollout_path) !== resolve(filename)) return null;
  const name = title(record.name);
  if (name) return { title: name, basis: 'source' };
  const storedTitle = title(record.title);
  // Preserve the actual stored title independently of its origin. A prompt-derived
  // title must not be replaced by a later eligible message or promoted to source.
  if (!storedTitle) return null;
  return { title: storedTitle, basis: storedTitle === title(record.first_user_message) ? 'derived' : 'source' };
}
export function antigravitySourceTitle(record) {
  const value = title(record?.title);
  return value ? { title: value, basis: 'source' } : null;
}
export function applyDisplayTitle(events, nativeTitle, genericTitle) {
  const firstPrompt = events.find((event) => event.role === 'user')?.text.split('\n')[0].slice(0,160);
  const display = nativeTitle?.title || firstPrompt || genericTitle;
  const basis = nativeTitle?.basis || (firstPrompt ? 'derived' : 'generic');
  return events.map((event) => ({ ...event, chatTitle: display,
    sourceMetadata: { ...event.sourceMetadata, titleBasis: basis } }));
}

export function eventForServer(event, capabilities = {}) {
  if (capabilities.sourceMetadataVersion === 1) return event;
  const { sourceMetadata: _evidence, ...legacy } = event;
  return legacy;
}

// This registry records only evidence in newly queued capable batches. Existing
// legacy chats cannot be retroactively promoted by a rename or a matching title.
export function rememberConversationMetadata(state, batch) {
  for (const event of batch.events) {
    if (!event.sourceMetadata || event.sourceMetadata.conversationIdentity === 'unknown') continue;
    const records = state.conversationMetadata ||= {};
    records[`${batch.product}:${event.conversationId}`] = { title: event.chatTitle,
      basis: event.sourceMetadata.titleBasis, identity: event.sourceMetadata.conversationIdentity,
      deviceId: batch.captureClient.deviceId };
  }
}
export function queueConversationTitle(state, template, conversationId, nativeTitle, capabilities,
  { maxPendingBatches = 100, maxPendingBytes = 20 * 1024 * 1024 } = {}) {
  if (capabilities?.sourceMetadataVersion !== 1 || capabilities?.conversationUpdatesVersion !== 1
      || !nativeTitle || !conversationId) return 'skipped';
  const key = `${template.product}:${conversationId}`;
  const previous = state.conversationMetadata?.[key];
  if (!previous || previous.identity === 'unknown' || previous.deviceId !== template.captureClient.deviceId
      || (previous.title === nativeTitle.title && previous.basis === nativeTitle.basis)) return 'skipped';
  const sourceMetadata = { version: 1, titleBasis: nativeTitle.basis, conversationIdentity: previous.identity,
    messageIdentity: 'unknown', timestampBasis: 'unknown', linksStatus: 'unknown', attachmentsStatus: 'unknown' };
  const { batchId: _oldId, ...basis } = template;
  const updateBasis = { ...basis, events: [], conversationUpdates: [{ conversationId,
    chatTitle: nativeTitle.title, capturedAt: template.clientCreatedAt, sourceMetadata }] };
  const batch = { ...updateBasis, batchId: stableUuid(JSON.stringify(updateBasis)) };
  const candidate = [...state.pending, { batch, attempts: 0, nextAttemptAt: null }];
  if (candidate.length > maxPendingBatches || Buffer.byteLength(JSON.stringify(candidate)) > maxPendingBytes) return 'full';
  const valid = validateCaptureBatch(batch);
  if (!valid.ok) throw new Error(`Conversation title update invalid: ${valid.errors[0]?.path}`);
  state.pending = candidate;
  state.conversationMetadata[key] = { ...previous, title: nativeTitle.title, basis: nativeTitle.basis };
  return 'queued';
}

const capabilityCache = new Map();
export async function captureServerCapabilities(endpoint, { fetchImpl = fetch, now = Date.now, forceRefresh = false } = {}) {
  if (!endpoint) return {};
  let url;
  try {
    url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash
      || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) return {};
    url.pathname = '/health';
  } catch { return {}; }
  const key = url.toString();
  const cached = capabilityCache.get(key);
  if (!forceRefresh && cached && now() < cached.expiresAt) return cached.value;
  let value = {};
  try {
    const response = await fetchImpl(key, { signal: AbortSignal.timeout(1500), cache: 'no-store' });
    const body = response.ok ? await response.json() : null;
    if (body?.ok === true && body.sourceMetadataVersion === 1) value = { sourceMetadataVersion: 1,
      ...(body.conversationUpdatesVersion === 1 ? { conversationUpdatesVersion: 1 } : {}) };
  } catch { /* An offline/older server keeps ordinary capture compatible. */ }
  capabilityCache.set(key, { value, expiresAt: now() + 60_000 });
  return value;
}

// Evaluate the immutable queued request; a newer display record is not the request.
export function batchNeedsSourceMetadata(batch) {
  return Boolean(batch.conversationUpdates?.length)
    || Boolean(batch.events?.some((event) => event.sourceMetadata != null));
}
export function supportsFrozenBatchMetadata(batch, capabilities) {
  return (!batchNeedsSourceMetadata(batch) || capabilities.sourceMetadataVersion === 1)
    && (!batch.conversationUpdates?.length || capabilities.conversationUpdatesVersion === 1);
}
