function secret(env) { return env.SUPABASE_SECRET_KEY || env.supabase_secret_key; }

async function database(path, env, fetchImpl, options = {}) {
  const key = secret(env);
  const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, authorization: `Bearer ${key}`, ...options.headers }
  });
  if (!response.ok) throw new Error(`Account deletion database request failed (${response.status}).`);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

export async function requestAccountDeletion(userId, workspaceId, env, fetchImpl = fetch) {
  return database("rpc/request_account_deletion", env, fetchImpl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ p_user_id: userId, p_workspace_id: workspaceId })
  });
}

export async function existingAccountDeletion(userId, workspaceId, env, fetchImpl = fetch) {
  const rows = await database(
    `account_deletion_jobs?user_id=eq.${encodeURIComponent(userId)}&workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id&limit=1`,
    env, fetchImpl
  );
  return rows.length === 1;
}

// Delete from the beginning of the prefix on each run. This avoids storing a
// cursor that would skip objects while the collection is being deleted.
async function retryRateLimit(operation) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!/\b429\b|too many requests|rate limit/i.test(error?.message || "") || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

async function clearPrefix(namespace, prefix, maximum = 200, parallelism = 20) {
  if (!namespace?.list || !namespace?.delete) throw new Error("Deletion storage is unavailable.");
  const entries = (page) => {
    const values = page?.objects ?? page?.keys;
    if (!Array.isArray(values)) throw new Error("Deletion storage returned an invalid list.");
    return values;
  };
  let removed = 0;
  while (removed < maximum) {
    const page = await retryRateLimit(() => namespace.list({ prefix, limit: Math.min(100, maximum - removed) }));
    const listed = entries(page);
    if (!listed.length) return true;
    for (let index = 0; index < listed.length; index += parallelism) {
      await Promise.all(listed.slice(index, index + parallelism).map((item) =>
        retryRateLimit(() => namespace.delete(item.key ?? item.name))));
    }
    removed += listed.length;
  }
  return !entries(await retryRateLimit(() => namespace.list({ prefix, limit: 1 }))).length;
}

async function removeAuthUser(userId, env, fetchImpl) {
  const key = secret(env);
  const response = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { apikey: key, authorization: `Bearer ${key}` }
  });
  if (!response.ok && response.status !== 404) throw new Error(`Auth account removal failed (${response.status}).`);
}

function nextCheck(completed) {
  return new Date(Date.now() + (completed ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000)).toISOString();
}

async function patchJob(jobId, values, env, fetchImpl) {
  await database(`account_deletion_jobs?id=eq.${encodeURIComponent(jobId)}`, env, fetchImpl, {
    method: "PATCH",
    headers: { "content-type": "application/json", prefer: "return=minimal" },
    body: JSON.stringify(values)
  });
}

export async function processAccountDeletion(job, env, fetchImpl = fetch) {
  let stage = "raw_archive_cleanup";
  try {
    const rawEmpty = await clearPrefix(env.RAW_MEMORY, `${job.workspace_id}/`);
    stage = "connector_cleanup";
    const grantsEmpty = await clearPrefix(env.OAUTH_KV, `grant:${job.user_id}:`, 200, 1);
    const tokensEmpty = await clearPrefix(env.OAUTH_KV, `token:${job.user_id}:`, 200, 1);
    if (!rawEmpty || !grantsEmpty || !tokensEmpty) {
      await patchJob(job.id, { attempt_count: job.attempt_count + 1, next_check_at: nextCheck(false), last_error: null }, env, fetchImpl);
      return { complete: false };
    }
    stage = "auth_account_removal";
    if (!job.auth_deleted_at) await removeAuthUser(job.user_id, env, fetchImpl);
    stage = "job_update";
    const now = new Date().toISOString();
    if (job.completed_at && Date.parse(job.expires_at) <= Date.now()) {
      await database(`account_deletion_jobs?id=eq.${encodeURIComponent(job.id)}`, env, fetchImpl, { method: "DELETE" });
      return { complete: true, retired: true };
    }
    await patchJob(job.id, {
      auth_deleted_at: job.auth_deleted_at || now,
      completed_at: job.completed_at || now,
      next_check_at: nextCheck(true),
      attempt_count: job.attempt_count + 1,
      last_error: null
    }, env, fetchImpl);
    return { complete: true };
  } catch (error) {
    await patchJob(job.id, {
      attempt_count: job.attempt_count + 1,
      next_check_at: nextCheck(false),
      last_error: `${stage}_failed`
    }, env, fetchImpl).catch(() => undefined);
    throw error;
  }
}

export async function reconcileAccountDeletions(env, fetchImpl = fetch) {
  const jobs = await database(
    `account_deletion_jobs?next_check_at=lte.${encodeURIComponent(new Date().toISOString())}&select=id,user_id,workspace_id,requested_at,auth_deleted_at,completed_at,expires_at,attempt_count&order=next_check_at.asc&limit=10`,
    env, fetchImpl
  );
  let complete = 0;
  for (const job of jobs) {
    try {
      if ((await processAccountDeletion(job, env, fetchImpl)).complete) complete += 1;
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "account_deletion_retry_pending", jobId: job.id, message: error?.message || "Unknown error" }));
    }
  }
  return { checked: jobs.length, complete };
}
