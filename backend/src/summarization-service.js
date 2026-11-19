import { captureEvidenceFor } from "./capture-evidence.js";
import { selectCheckpointInput } from "./checkpoints.js";
import { decryptSecret } from "./crypto.js";
import { SummarizerGatewayError, summarizeCheckpoint } from "./summarizer-gateway.js";
import { estimateSummarizationCostUsd } from "./summarization-cost.js";
import { canonicalSummarizerModel } from "./settings.js";

const MAX_SCHEDULED_JOBS_PER_CYCLE = 3;
const MAX_WORKSPACES_PER_CYCLE = 50;
const MAX_CONVERSATIONS_PER_WORKSPACE = 500;
const SELECTION_BATCH_SIZE = 20;
const EVENT_PAGE_SIZE = 1000;
const STALE_PROCESSING_MINUTES = 5;
const SUMMARIZER_IMPLEMENTATION_VERSION = "runtime-5";

function secretKey(env) {
  return env.SUPABASE_SECRET_KEY || env.supabase_secret_key;
}

function serviceHeaders(env, extra = {}) {
  return { apikey: secretKey(env), authorization: `Bearer ${secretKey(env)}`, ...extra };
}

async function supabaseJson(path, env, fetchImpl, options = {}) {
  const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: serviceHeaders(env, options.headers)
  });
  if (!response.ok) throw new Error(`Supabase request failed with ${response.status}`);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

async function supabasePagedRows(path, env, fetchImpl) {
  const rows = [];
  for (let offset = 0; ; offset += EVENT_PAGE_SIZE) {
    const page = await supabaseJson(`${path}&limit=${EVENT_PAGE_SIZE}&offset=${offset}`, env, fetchImpl);
    rows.push(...page);
    if (page.length < EVENT_PAGE_SIZE) return rows;
  }
}

async function rpc(name, payload, env, fetchImpl) {
  return supabaseJson(`rpc/${name}`, env, fetchImpl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

function asDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function workspaceIsDue(settings, now) {
  const last = asDate(settings.last_scheduled_at);
  return !last || now.getTime() - last.getTime() >= Number(settings.interval_minutes) * 60_000;
}

function eventPath(ids) {
  return ids.map((id) => String(id)).join(",");
}

function publicJobResult(job, completion = null) {
  return {
    jobId: job.id,
    conversationId: job.conversation_id,
    status: completion?.completed === false ? "skipped" : "completed",
    checkpointId: completion?.checkpointId || null,
    version: completion?.version || null,
    reason: completion?.reason || null
  };
}

async function failJob(jobId, error, now, env, fetchImpl, skip = false) {
  const known = error instanceof SummarizerGatewayError;
  return rpc("fail_summarization_job", {
    p_job_id: jobId,
    p_retryable: known ? error.retryable : true,
    p_error_code: known ? error.code : "summarization_internal_error",
    p_error_detail: known ? error.message : "The summarization service could not complete this attempt.",
    p_skip: skip,
    p_now: now.toISOString()
  }, env, fetchImpl);
}

async function recordSummarizationWarning(job, warnings, now, env, fetchImpl) {
  if (!warnings?.length) return;
  await supabaseJson("diagnostic_events", env, fetchImpl, {
    method: "POST",
    headers: { "content-type": "application/json", prefer: "return=minimal" },
    body: JSON.stringify({
      workspace_id: job.workspace_id,
      provider: null,
      stage: "summarization_output_sanitized",
      status: "warning",
      detail: {
        conversationId: job.conversation_id,
        jobId: job.id,
        droppedItems: warnings.length,
        warnings: warnings.slice(0, 10)
      },
      created_at: now.toISOString()
    })
  });
}

async function loadJobInput(job, env, fetchImpl) {
  const ids = [...job.overlap_event_ids, ...job.new_event_ids].map(String);
  const [conversations, events, checkpoints, secrets] = await Promise.all([
    supabaseJson(
      `conversations?id=eq.${encodeURIComponent(job.conversation_id)}&workspace_id=eq.${encodeURIComponent(job.workspace_id)}&select=id,provider,title,canonical_chat_url&limit=1`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `conversation_events?workspace_id=eq.${encodeURIComponent(job.workspace_id)}&conversation_id=eq.${encodeURIComponent(job.conversation_id)}&id=in.(${eventPath(ids)})&select=id,role,text_content,sequence,revision,message_timestamp,captured_at,last_captured_at,source_locator,coverage_state,capture_evidence&order=id.asc`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `checkpoints?conversation_id=eq.${encodeURIComponent(job.conversation_id)}&status=in.(active,user_edited)&select=id,summary_text,last_event_id,version&order=version.desc&limit=1`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `summarizer_secrets?workspace_id=eq.${encodeURIComponent(job.workspace_id)}&select=provider,key_ciphertext,key_iv,key_version&limit=1`,
      env,
      fetchImpl
    ),
  ]);

  if (conversations.length !== 1 || secrets.length !== 1 || secrets[0].provider !== job.provider) {
    throw new SummarizerGatewayError(
      "summarizer_not_configured",
      "The selected provider no longer has a saved API key. Save a compatible key before trying again."
    );
  }
  const byId = new Map(events.map((event) => [String(event.id), event]));
  if (ids.some((id) => !byId.has(id) || Number(byId.get(id).revision) !== Number(job.event_revisions[id]))) {
    throw new SummarizerGatewayError(
      "source_revision_changed",
      "A source message changed before summarization began. A fresh job is required."
    );
  }
  const toGatewayEvent = (id) => {
    const event = byId.get(String(id));
    return {
      id: String(event.id),
      role: event.role,
      text: event.text_content,
      revision: Number(event.revision),
      capturedAt: event.last_captured_at || event.captured_at,
      messageTimestamp: event.message_timestamp || null,
      sequence: event.sequence,
      coverage: event.coverage_state || "unknown",
      captureEvidence: captureEvidenceFor(event)
    };
  };
  const secret = await decryptSecret({
    ciphertext: secrets[0].key_ciphertext,
    iv: secrets[0].key_iv,
    keyVersion: secrets[0].key_version
  }, env.SETTINGS_ENCRYPTION_KEY);

  return {
    input: {
      conversation: {
        title: conversations[0].title,
        provider: conversations[0].provider,
        sourceUrl: conversations[0].canonical_chat_url
      },
      previousSummary: checkpoints[0]?.summary_text || null,
      overlapEvents: job.overlap_event_ids.map(toGatewayEvent),
      newEvents: job.new_event_ids.map(toGatewayEvent)
    },
    config: { provider: job.provider, model: job.model, apiKey: secret }
  };
}

export async function executeSummarizationJob(jobId, env, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const summarize = dependencies.summarize || summarizeCheckpoint;
  const now = dependencies.now || new Date();
  const job = await rpc("claim_summarization_job", {
    p_job_id: jobId,
    p_now: now.toISOString()
  }, env, fetchImpl);
  if (!job) return { jobId, status: "not_claimed" };

  try {
    const { input, config } = await loadJobInput(job, env, fetchImpl);
    const result = await summarize(input, config, { fetch: fetchImpl });
    const completion = await rpc("complete_summarization_job", {
      p_job_id: job.id,
      p_output: { ...result.output, claims: [] },
      p_usage: { ...result.usage, estimatedCostUsd: estimateSummarizationCostUsd(config.provider, config.model, result.usage) },
      p_model_version: result.modelVersion,
      p_provider_request_id: result.providerRequestId,
      p_now: now.toISOString()
    }, env, fetchImpl);
    try {
      await recordSummarizationWarning(job, result.warnings, now, env, fetchImpl);
    } catch (warningError) {
      console.error(JSON.stringify({ level: "warning", event: "summarization_warning_log_failed", jobId: job.id, message: warningError?.message }));
    }
    return publicJobResult(job, completion);
  } catch (error) {
    const skip = error instanceof SummarizerGatewayError
      && ["summarizer_not_configured", "source_revision_changed"].includes(error.code);
    const failure = await failJob(job.id, error, now, env, fetchImpl, skip);
    return {
      jobId: job.id,
      conversationId: job.conversation_id,
      status: failure.status,
      retryScheduled: failure.retryScheduled,
      errorCode: error instanceof SummarizerGatewayError ? error.code : "summarization_internal_error",
      errorDetail: error instanceof SummarizerGatewayError
        ? error.message
        : "The summarization service could not complete this attempt."
    };
  }
}

async function loadWorkspaceSelectionState(conversations, settings, env, fetchImpl) {
  if (!conversations.length) return new Map();
  const conversationIds = conversations.map((conversation) => conversation.id);
  const filter = eventPath(conversationIds);
  const [events, checkpoints, terminalJobs] = await Promise.all([
    supabasePagedRows(
      `conversation_events?workspace_id=eq.${encodeURIComponent(settings.workspace_id)}&conversation_id=in.(${filter})&select=id,conversation_id,revision,captured_at,last_captured_at&order=id.asc`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `checkpoints?workspace_id=eq.${encodeURIComponent(settings.workspace_id)}&conversation_id=in.(${filter})&status=in.(active,user_edited,deleted)&select=id,conversation_id,last_event_id,summary_text,status,version&order=version.desc`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `summarization_jobs?workspace_id=eq.${encodeURIComponent(settings.workspace_id)}&conversation_id=in.(${filter})&status=in.(failed,skipped)&select=conversation_id,new_event_ids,overlap_event_ids,event_revisions,provider,model,prompt_version,error_code,created_at&order=created_at.desc&limit=500`,
      env,
      fetchImpl
    )
  ]);
  const latestTerminalByConversation = new Map();
  for (const job of terminalJobs) {
    if (!latestTerminalByConversation.has(job.conversation_id)) latestTerminalByConversation.set(job.conversation_id, job);
  }
  const latestByConversation = new Map();
  for (const checkpoint of checkpoints) {
    if (!latestByConversation.has(checkpoint.conversation_id)) latestByConversation.set(checkpoint.conversation_id, checkpoint);
  }
  const latestIds = [...latestByConversation.values()].map((checkpoint) => checkpoint.id);
  const included = latestIds.length
    ? await supabaseJson(
      `checkpoint_events?checkpoint_id=in.(${eventPath(latestIds)})&select=checkpoint_id,conversation_event_id,included_revision`,
      env,
      fetchImpl
    )
    : [];
  const includedByCheckpoint = new Map();
  for (const row of included) {
    if (!includedByCheckpoint.has(row.checkpoint_id)) includedByCheckpoint.set(row.checkpoint_id, {});
    includedByCheckpoint.get(row.checkpoint_id)[String(row.conversation_event_id)] = Number(row.included_revision);
  }
  const state = new Map(conversations.map((conversation) => [conversation.id, {
    events: [],
    latestCheckpoint: null,
    includedRevisions: {},
    latestTerminalFailure: latestTerminalByConversation.get(conversation.id) || null
  }]));
  for (const event of events) {
    state.get(event.conversation_id)?.events.push({
      id: String(event.id),
      revision: Number(event.revision),
      capturedAt: event.captured_at,
      lastCapturedAt: event.last_captured_at
    });
  }
  for (const [conversationId, checkpoint] of latestByConversation) {
    const conversationState = state.get(conversationId);
    conversationState.latestCheckpoint = {
      lastEventId: checkpoint.last_event_id,
      summary: checkpoint.status === "deleted" ? null : checkpoint.summary_text
    };
    conversationState.includedRevisions = includedByCheckpoint.get(checkpoint.id) || {};
  }
  return state;
}

function sameList(left, right) {
  return JSON.stringify((left || []).map(String)) === JSON.stringify((right || []).map(String));
}

function effectivePromptVersion(settings) {
  return `${settings.prompt_version}-${SUMMARIZER_IMPLEMENTATION_VERSION}`;
}

function unchangedTerminalFailure(failure, selection, eventRevisions, settings) {
  if (!failure) return false;
  const failureAt = Date.parse(failure.created_at || "");
  const settingsUpdatedAt = Date.parse(settings.updated_at || "");
  if (Number.isFinite(failureAt) && Number.isFinite(settingsUpdatedAt) && settingsUpdatedAt > failureAt) {
    return false;
  }
  if (failure.error_code === "provider_authentication_failed") {
    return failure.provider === settings.provider && failure.model === settings.model;
  }
  return sameList(failure.new_event_ids, selection.newEventIds)
    && sameList(failure.overlap_event_ids, selection.overlapEventIds)
    && JSON.stringify(failure.event_revisions || {}) === JSON.stringify(eventRevisions)
    && failure.provider === settings.provider
    && failure.model === settings.model
    && failure.prompt_version === effectivePromptVersion(settings);
}

async function createJobForConversation(conversation, selectionState, settings, reason, force, now, env, fetchImpl) {
  const selection = selectCheckpointInput({
    events: selectionState.events,
    latestCheckpoint: selectionState.latestCheckpoint,
    includedRevisions: selectionState.includedRevisions,
    settings: {
      intervalMinutes: force ? 0 : Number(settings.interval_minutes),
      continuityOverlapEvents: Number(settings.continuity_overlap_events)
    },
    now
  });
  if (!selection.eligible) return { created: false, reason: selection.reason };

  const selected = [...selection.overlapEvents, ...selection.newEvents];
  const eventRevisions = Object.fromEntries(selected.map((event) => [String(event.id), Number(event.revision)]));
  if (unchangedTerminalFailure(selectionState.latestTerminalFailure, selection, eventRevisions, settings)) {
    return {
      created: false,
      reason: "unchanged_terminal_failure",
      blockedBySafeguard: true,
      errorCode: selectionState.latestTerminalFailure.error_code
    };
  }
  return rpc("enqueue_summarization_job", {
    p_workspace_id: settings.workspace_id,
    p_conversation_id: conversation.id,
    p_reason: reason,
    p_new_event_ids: selection.newEventIds,
    p_overlap_event_ids: selection.overlapEventIds,
    p_event_revisions: eventRevisions,
    p_provider: settings.provider,
    p_model: settings.model,
    p_prompt_version: effectivePromptVersion(settings),
    p_now: now.toISOString()
  }, env, fetchImpl);
}

async function recoverStaleJobs(now, workspaceIds, env, fetchImpl) {
  if (!workspaceIds.length) return;
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MINUTES * 60_000).toISOString();
  const stale = await supabaseJson(
    `summarization_jobs?workspace_id=in.(${eventPath(workspaceIds)})&status=eq.processing&claimed_at=lt.${encodeURIComponent(staleBefore)}&select=id&order=claimed_at.asc&limit=10`,
    env,
    fetchImpl
  );
  for (const job of stale) {
    await rpc("fail_summarization_job", {
      p_job_id: job.id,
      p_retryable: true,
      p_error_code: "processing_lease_expired",
      p_error_detail: "The prior processing attempt did not finish before its lease expired.",
      p_skip: false,
      p_now: now.toISOString()
    }, env, fetchImpl);
  }
}

async function processPendingJobs(maxJobs, now, workspaceIds, env, fetchImpl, dependencies) {
  if (!workspaceIds.length) return [];
  const pending = await supabaseJson(
    `summarization_jobs?workspace_id=in.(${eventPath(workspaceIds)})&status=eq.pending&eligible_after=lte.${encodeURIComponent(now.toISOString())}&select=id&order=eligible_after.asc,created_at.asc&limit=${maxJobs}`,
    env,
    fetchImpl
  );
  const results = [];
  for (const job of pending) {
    results.push(await executeSummarizationJob(job.id, env, { ...dependencies, fetch: fetchImpl, now }));
  }
  return results;
}

export async function runSummarizationCycle(options, env, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || new Date();
  const reason = options.reason || "scheduled";
  const manual = reason === "manual";
  const maxJobs = manual ? 1 : Number(options.maxJobs || MAX_SCHEDULED_JOBS_PER_CYCLE);
  const results = [];
  const safeguards = [];

  const settingsPath = options.workspaceId
    ? `summarizer_settings?workspace_id=eq.${encodeURIComponent(options.workspaceId)}&select=*&limit=1`
    : `summarizer_settings?enabled=eq.true&api_key_configured=eq.true&model=not.is.null&select=*&order=last_scheduled_at.asc.nullsfirst&limit=${MAX_WORKSPACES_PER_CYCLE}`;
  const settingsRows = (await supabaseJson(settingsPath, env, fetchImpl)).map((settings) => ({
    ...settings,
    model: canonicalSummarizerModel(settings.provider, settings.model)
  }));
  if (!settingsRows.length) return { status: "not_configured", jobs: results };

  if (!manual) {
    const enabledWorkspaceIds = settingsRows.map((settings) => settings.workspace_id);
    await recoverStaleJobs(now, enabledWorkspaceIds, env, fetchImpl);
    results.push(...await processPendingJobs(maxJobs, now, enabledWorkspaceIds, env, fetchImpl, dependencies));
    if (results.length >= maxJobs) return { status: "processed", jobs: results, safeguards };
  }

  for (const settings of settingsRows) {
    if (!manual && (!settings.enabled || !settings.api_key_configured || !settings.model || !workspaceIsDue(settings, now))) continue;
    if (manual && (!settings.api_key_configured || !settings.model)) {
      return { status: "not_configured", jobs: results };
    }
    const conversationFilter = options.conversationId
      ? `&id=eq.${encodeURIComponent(options.conversationId)}`
      : "";
    const conversations = await supabaseJson(
      `conversations?workspace_id=eq.${encodeURIComponent(settings.workspace_id)}${conversationFilter}&select=id&order=last_captured_at.asc&limit=${MAX_CONVERSATIONS_PER_WORKSPACE}`,
      env,
      fetchImpl
    );
    for (let offset = 0; offset < conversations.length && results.length < maxJobs; offset += SELECTION_BATCH_SIZE) {
      const batch = conversations.slice(offset, offset + SELECTION_BATCH_SIZE);
      const selectionState = await loadWorkspaceSelectionState(batch, settings, env, fetchImpl);
      for (const conversation of batch) {
        if (results.length >= maxJobs) break;
        const queued = await createJobForConversation(
          conversation,
          selectionState.get(conversation.id),
          settings,
          reason,
          manual,
          now,
          env,
          fetchImpl
        );
        if (queued.blockedBySafeguard) {
          safeguards.push({
            conversationId: conversation.id,
            reason: queued.reason,
            errorCode: queued.errorCode,
            modelCallPrevented: true
          });
        }
        if (queued.jobId) {
          const result = await executeSummarizationJob(queued.jobId, env, { ...dependencies, fetch: fetchImpl, now });
          if (result.status !== "not_claimed") results.push(result);
        }
      }
    }
    if (!manual) {
      await supabaseJson(`summarizer_settings?workspace_id=eq.${encodeURIComponent(settings.workspace_id)}`, env, fetchImpl, {
        method: "PATCH",
        headers: { "content-type": "application/json", prefer: "return=minimal" },
        body: JSON.stringify({ last_scheduled_at: now.toISOString() })
      });
    }
    if (results.length >= maxJobs) break;
  }

  return { status: results.length ? "processed" : safeguards.length ? "protected" : "no_work", jobs: results, safeguards };
}

export const summarizationLimits = Object.freeze({
  maxScheduledJobsPerCycle: MAX_SCHEDULED_JOBS_PER_CYCLE,
  maxWorkspacesPerCycle: MAX_WORKSPACES_PER_CYCLE,
  maxConversationsPerWorkspace: MAX_CONVERSATIONS_PER_WORKSPACE,
  staleProcessingMinutes: STALE_PROCESSING_MINUTES
});
