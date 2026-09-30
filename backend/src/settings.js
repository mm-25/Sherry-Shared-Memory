import { encryptSecret } from "./crypto.js";

export const summarizerDefaults = Object.freeze({
  enabled: true,
  intervalMinutes: 10,
  provider: "anthropic",
  model: null,
  promptVersion: "checkpoint-v2"
});

const allowedIntervals = new Set([5, 10, 30, 60]);
const allowedProviders = new Set(["anthropic", "openai", "google", "xai"]);
// Retained only for the existing database columns and summary context window.
const checkpointStorageDefaults = Object.freeze({ minNewEvents: 1, maxSingleEventWaitMinutes: 5, continuityOverlapEvents: 2 });

export function canonicalSummarizerModel(provider, model) {
  const normalized = typeof model === "string" ? model.trim() : model;
  if (provider === "anthropic" && normalized === "claude-sonnet") return "claude-sonnet-5";
  return normalized;
}

export function validateSummarizerSettings(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: [{ field: "body", message: "Settings must be a JSON object." }] };
  }
  if (typeof payload.enabled !== "boolean") errors.push({ field: "enabled", message: "Choose whether automatic summarization is on or off." });
  if (!allowedIntervals.has(payload.intervalMinutes)) errors.push({ field: "intervalMinutes", message: "Choose 5, 10, 30, or 60 minutes." });
  if (!allowedProviders.has(payload.provider)) errors.push({ field: "provider", message: "Choose Anthropic, OpenAI, Google, or xAI (Grok)." });

  const model = canonicalSummarizerModel(payload.provider, payload.model);
  if (model != null && model !== "" && (typeof model !== "string" || model.length > 160)) {
    errors.push({ field: "model", message: "Model must be blank or between 1 and 160 characters." });
  }
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : payload.apiKey;
  if (apiKey != null && apiKey !== "" && (apiKey.length < 8 || apiKey.length > 512)) {
    errors.push({ field: "apiKey", message: "The API key must be between 8 and 512 characters." });
  }
  if (payload.removeApiKey != null && typeof payload.removeApiKey !== "boolean") {
    errors.push({ field: "removeApiKey", message: "removeApiKey must be true or false." });
  }
  if (payload.removeApiKey === true && apiKey) {
    errors.push({ field: "apiKey", message: "Enter a replacement key or remove the saved key, not both." });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      enabled: payload.enabled,
      intervalMinutes: payload.intervalMinutes,
      provider: payload.provider,
      model: model || null,
      apiKey: apiKey || null,
      removeApiKey: payload.removeApiKey === true
    }
  };
}

function databaseRow(workspaceId, settings, apiKeyConfigured, apiKeyHint) {
  return {
    workspace_id: workspaceId,
    enabled: settings.enabled,
    interval_minutes: settings.intervalMinutes,
    min_new_events: checkpointStorageDefaults.minNewEvents,
    max_single_event_wait_minutes: checkpointStorageDefaults.maxSingleEventWaitMinutes,
    continuity_overlap_events: checkpointStorageDefaults.continuityOverlapEvents,
    provider: settings.provider,
    model: settings.model,
    prompt_version: summarizerDefaults.promptVersion,
    api_key_configured: apiKeyConfigured,
    api_key_hint: apiKeyHint,
    updated_at: new Date().toISOString()
  };
}

export function publicSettings(row, hasStoredSecret = false) {
  const source = row || {};
  return {
    enabled: source.enabled ?? summarizerDefaults.enabled,
    intervalMinutes: source.interval_minutes ?? summarizerDefaults.intervalMinutes,
    provider: source.provider ?? summarizerDefaults.provider,
    model: canonicalSummarizerModel(source.provider ?? summarizerDefaults.provider, source.model ?? summarizerDefaults.model),
    promptVersion: source.prompt_version ?? summarizerDefaults.promptVersion,
    apiKeyConfigured: hasStoredSecret,
    apiKeyHint: hasStoredSecret ? source.api_key_hint || null : null
  };
}

function keyHint(apiKey) {
  return `ending in ${apiKey.slice(-4)}`;
}

export async function getSummarizerSettings(workspaceId, env, supabaseJson) {
  const [rows, secrets] = await Promise.all([
    supabaseJson(`summarizer_settings?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=*&limit=1`),
    supabaseJson(`summarizer_secrets?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=workspace_id&limit=1`)
  ]);
  if (rows.length) return publicSettings(rows[0], secrets.length === 1);

  const row = databaseRow(workspaceId, summarizerDefaults, false, null);
  await supabaseJson("summarizer_settings?on_conflict=workspace_id", {
    method: "POST",
    headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row)
  });
  return publicSettings(row, false);
}

export async function saveSummarizerSettings(workspaceId, userId, settings, env, supabaseJson) {
  const [currentRows, currentSecrets] = await Promise.all([
    supabaseJson(`summarizer_settings?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=*&limit=1`),
    supabaseJson(`summarizer_secrets?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=workspace_id,provider&limit=1`)
  ]);
  const current = currentRows[0] || null;
  const currentSecret = currentSecrets[0] || null;
  const providerChanged = Boolean(currentSecret && currentSecret.provider !== settings.provider);
  const shouldRemove = settings.removeApiKey || (providerChanged && !settings.apiKey);
  let secretAction = shouldRemove ? "delete" : "keep";
  let encrypted = null;
  let hint = current?.api_key_hint || null;

  if (settings.apiKey) {
    if (!env.SETTINGS_ENCRYPTION_KEY) throw new Error("Summarizer encryption is not configured.");
    encrypted = await encryptSecret(settings.apiKey, env.SETTINGS_ENCRYPTION_KEY);
    secretAction = "upsert";
    hint = keyHint(settings.apiKey);
  }

  const saved = await supabaseJson("rpc/save_summarizer_configuration", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      p_workspace_id: workspaceId,
      p_user_id: userId,
      p_enabled: settings.enabled,
      p_interval_minutes: settings.intervalMinutes,
      p_min_new_events: checkpointStorageDefaults.minNewEvents,
      p_max_single_event_wait_minutes: checkpointStorageDefaults.maxSingleEventWaitMinutes,
      p_continuity_overlap_events: checkpointStorageDefaults.continuityOverlapEvents,
      p_provider: settings.provider,
      p_model: settings.model,
      p_prompt_version: summarizerDefaults.promptVersion,
      p_secret_action: secretAction,
      p_key_ciphertext: encrypted?.ciphertext || null,
      p_key_iv: encrypted?.iv || null,
      p_key_version: encrypted?.keyVersion || null,
      p_api_key_hint: secretAction === "upsert" ? hint : null,
      p_now: new Date().toISOString()
    })
  });
  return publicSettings(saved, saved?.api_key_configured === true);
}
