import { classifyConflict } from "./conflict-classification.js";

function secretKey(env) {
  return env.SUPABASE_SECRET_KEY || env.supabase_secret_key;
}

function headers(env, extra = {}) {
  return { apikey: secretKey(env), authorization: `Bearer ${secretKey(env)}`, ...extra };
}

async function supabaseJson(path, env, fetchImpl, options = {}) {
  const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: headers(env, options.headers)
  });
  if (!response.ok) throw new Error(`Supabase request failed with ${response.status}`);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

async function rpc(name, payload, env, fetchImpl) {
  return supabaseJson(`rpc/${name}`, env, fetchImpl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

function inFilter(values) {
  return values.map(String).join(",");
}

function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!grouped.has(value)) grouped.set(value, []);
    grouped.get(value).push(row);
  }
  return grouped;
}

async function fetchRowsByIds(table, column, ids, select, workspaceId, env, fetchImpl) {
  if (!ids.length) return [];
  const batches = [];
  for (let offset = 0; offset < ids.length; offset += 60) {
    const batch = ids.slice(offset, offset + 60);
    batches.push(supabaseJson(
      `${table}?${column}=in.(${inFilter(batch)})&workspace_id=eq.${encodeURIComponent(workspaceId)}&select=${select}`,
      env,
      fetchImpl
    ));
  }
  return (await Promise.all(batches)).flat();
}

export async function listSummaries(workspaceId, env, fetchImpl = globalThis.fetch) {
  const checkpoints = [];
  const pageSize = 100;
  for (let offset = 0; offset < 500; offset += pageSize) {
    const page = await supabaseJson(
      `checkpoints?workspace_id=eq.${encodeURIComponent(workspaceId)}&status=in.(active,user_edited)&select=id,conversation_id,version,summary_text,topics,open_threads,key_decisions,status,source_availability,provider,model,model_version,input_tokens,output_tokens,cached_input_tokens,total_tokens,estimated_cost_usd,exact_cost_usd,created_at,edited_at&order=created_at.desc,id.desc&limit=${pageSize}&offset=${offset}`,
      env,
      fetchImpl
    );
    checkpoints.push(...page);
    if (page.length < pageSize) break;
  }
  if (!checkpoints.length) return [];
  const conversations = [];
  for (let offset = 0; offset < checkpoints.length; offset += pageSize) {
    const batch = checkpoints.slice(offset, offset + pageSize);
    const conversationIds = [...new Set(batch.map((item) => item.conversation_id))];
    const batchConversations = await supabaseJson(
      `conversations?id=in.(${inFilter(conversationIds)})&workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,provider,title,canonical_chat_url,last_captured_at`,
      env,
      fetchImpl
    );
    conversations.push(...batchConversations);
  }
  const conversationById = new Map(conversations.map((item) => [item.id, item]));
  return checkpoints.map((checkpoint) => ({
    ...checkpoint,
    conversation: conversationById.get(checkpoint.conversation_id) || null
  }));
}

export async function getSummary(workspaceId, checkpointId, env, fetchImpl = globalThis.fetch) {
  const rows = await supabaseJson(
    `checkpoints?id=eq.${encodeURIComponent(checkpointId)}&workspace_id=eq.${encodeURIComponent(workspaceId)}&select=*&limit=1`,
    env,
    fetchImpl
  );
  if (!rows.length) return null;
  const checkpoint = rows[0];
  const [conversations, lineage, history] = await Promise.all([
    supabaseJson(
      `conversations?id=eq.${encodeURIComponent(checkpoint.conversation_id)}&workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,provider,title,canonical_chat_url&limit=1`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `checkpoint_events?checkpoint_id=eq.${encodeURIComponent(checkpoint.id)}&select=conversation_event_id,inclusion_type,position,included_revision&order=position.asc`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `checkpoints?conversation_id=eq.${encodeURIComponent(checkpoint.conversation_id)}&select=id,version,status,created_at,edited_at,previous_checkpoint_id&order=version.desc`,
      env,
      fetchImpl
    ),
  ]);
  const eventIds = lineage.map((item) => item.conversation_event_id);
  const events = eventIds.length
    ? await supabaseJson(
      `conversation_events?id=in.(${inFilter(eventIds)})&workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,role,text_content,source_url,message_timestamp,captured_at,revision&order=id.asc`,
      env,
      fetchImpl
    )
    : [];
  const lineageById = new Map(lineage.map((item) => [String(item.conversation_event_id), item]));
  return {
    ...checkpoint,
    conversation: conversations[0] || null,
    events: events
      .map((event) => ({ ...event, ...lineageById.get(String(event.id)) }))
      .sort((left, right) => Number(left.position || 0) - Number(right.position || 0)),
    history
  };
}

export async function editSummary(workspaceId, checkpointId, summaryText, userId, env, fetchImpl = globalThis.fetch) {
  return rpc("edit_checkpoint_summary", {
    p_workspace_id: workspaceId,
    p_checkpoint_id: checkpointId,
    p_summary_text: summaryText,
    p_actor_user_id: userId
  }, env, fetchImpl);
}

export async function deleteSummary(workspaceId, checkpointId, userId, env, fetchImpl = globalThis.fetch) {
  return rpc("delete_checkpoint_summary", {
    p_workspace_id: workspaceId,
    p_checkpoint_id: checkpointId,
    p_actor_user_id: userId
  }, env, fetchImpl);
}

export async function listMemory(workspaceId, env, fetchImpl = globalThis.fetch) {
  const encodedWorkspaceId = encodeURIComponent(workspaceId);
  const [activeClaims, conflictQueue] = await Promise.all([
    supabaseJson(
      `memory_claims?workspace_id=eq.${encodedWorkspaceId}&status=neq.deleted&select=*&order=updated_at.desc&limit=200`,
      env,
      fetchImpl
    ),
    rpc("list_review_conflicts", { p_workspace_id: workspaceId, p_limit: 2000 }, env, fetchImpl)
  ]);
  const candidates = (conflictQueue?.items || []).map((item) => ({
    ...item,
    preliminaryClassification: item.left_text && item.right_text
      ? classifyConflict({ display_text: item.left_text }, { display_text: item.right_text })
      : null
  }));
  const actionableCandidates = candidates.filter((item) => !item.preliminaryClassification || item.preliminaryClassification.kind === "needs_review").slice(0, 100);
  const similarCandidates = candidates.filter((item) => ["restatement", "refinement"].includes(item.preliminaryClassification?.kind)).slice(0, 5);
  const conflicts = [...actionableCandidates, ...similarCandidates];
  const activeClaimIds = new Set(activeClaims.map((item) => item.id));
  const missingConflictClaimIds = [...new Set(conflicts.flatMap((item) => [item.left_claim_id, item.right_claim_id]).filter((id) => id && !activeClaimIds.has(id)))];
  const historicalClaims = await fetchRowsByIds("memory_claims", "id", missingConflictClaimIds, "*", workspaceId, env, fetchImpl);
  const claims = [...activeClaims, ...historicalClaims];
  const claimIds = claims.map((item) => item.id);
  const [evidence, reviews] = await Promise.all([
    fetchRowsByIds("memory_evidence", "memory_claim_id", claimIds, "id,memory_claim_id,conversation_event_id,checkpoint_id,evidence_role,created_at", workspaceId, env, fetchImpl),
    fetchRowsByIds("memory_claim_reviews", "memory_claim_id", claimIds, "id,memory_claim_id,decision,previous_status,new_status,previous_review_state,new_review_state,detail,created_at", workspaceId, env, fetchImpl)
  ]);
  const eventIds = [...new Set(evidence.map((item) => item.conversation_event_id).filter(Boolean))];
  const checkpointIds = [...new Set(evidence.map((item) => item.checkpoint_id).filter(Boolean))];
  const conversationIds = [...new Set(claims.map((item) => item.conversation_id).filter(Boolean))];
  const [events, checkpoints, conversations] = await Promise.all([
    fetchRowsByIds("conversation_events", "id", eventIds, "id,conversation_id,role,text_content,source_url,message_timestamp,captured_at", workspaceId, env, fetchImpl),
    fetchRowsByIds("checkpoints", "id", checkpointIds, "id,conversation_id,version,status", workspaceId, env, fetchImpl),
    fetchRowsByIds("conversations", "id", conversationIds, "id,title,provider,canonical_chat_url,last_captured_at", workspaceId, env, fetchImpl)
  ]);
  const conversationById = new Map(conversations.map((item) => [item.id, item]));
  const eventById = new Map(events.map((item) => [String(item.id), item]));
  const checkpointById = new Map(checkpoints.map((item) => [item.id, item]));
  const evidenceByClaim = groupBy(evidence, "memory_claim_id");
  const reviewsByClaim = groupBy(reviews, "memory_claim_id");
  const enriched = claims.map((claim) => ({
    ...claim,
    conversation: conversationById.get(claim.conversation_id) || null,
    evidence: (evidenceByClaim.get(claim.id) || []).map((item) => ({
      ...item,
      event: item.conversation_event_id ? eventById.get(String(item.conversation_event_id)) || null : null,
      checkpoint: item.checkpoint_id ? checkpointById.get(item.checkpoint_id) || null : null
    })),
    reviewHistory: reviewsByClaim.get(claim.id) || []
  }));
  const claimById = new Map(enriched.map((item) => [item.id, item]));
  const classifiedConflicts = conflicts.map((conflict) => {
    const leftClaim = claimById.get(conflict.left_claim_id) || null;
    const rightClaim = claimById.get(conflict.right_claim_id) || null;
    const { preliminaryClassification, ...record } = conflict;
    return { ...record, leftClaim, rightClaim, classification: preliminaryClassification || classifyConflict(leftClaim, rightClaim) };
  });
  const similarMemories = classifiedConflicts.filter((conflict) => ["restatement", "refinement"].includes(conflict.classification.kind));
  return {
    claims: enriched.filter((claim) => claim.status !== "deleted"),
    conflicts: classifiedConflicts.filter((conflict) => conflict.classification.kind === "needs_review"),
    similarMemories,
    similarMemoryCount: candidates.filter((item) => ["restatement", "refinement"].includes(item.preliminaryClassification?.kind)).length
      + similarMemories.filter((item) => !item.left_text || !item.right_text).length,
    conflictQueue: {
      totalCandidatePairs: Number(conflictQueue?.total || 0),
      loadedCandidatePairs: candidates.length,
      actionableCandidatePairs: candidates.filter((item) => item.preliminaryClassification?.kind === "needs_review").length
        + classifiedConflicts.filter((item) => (!item.left_text || !item.right_text) && item.classification.kind === "needs_review").length
    }
  };
}

export async function reviewClaim(workspaceId, claimId, decision, userId, env, fetchImpl = globalThis.fetch) {
  return rpc("review_memory_claim", {
    p_workspace_id: workspaceId,
    p_claim_id: claimId,
    p_decision: decision,
    p_actor_user_id: userId
  }, env, fetchImpl);
}

export async function resolveConflict(workspaceId, conflictId, resolution, userId, env, fetchImpl = globalThis.fetch) {
  return rpc("resolve_memory_conflict", {
    p_workspace_id: workspaceId,
    p_conflict_id: conflictId,
    p_resolution: resolution,
    p_actor_user_id: userId
  }, env, fetchImpl);
}
