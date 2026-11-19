const SUPABASE_URL = "https://zwpzmmfpgjaaikacoqas.supabase.co";
const SUPABASE_KEY = "sb_publishable_mEtfpCKWHYDKARfWNNO5BA_ouWQWmfN";
export const WORKER_URL = "https://shared-memory-ingestion.mufaddal-m25.workers.dev";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let nextRefreshAttemptAt = 0;

export function validateConnection(value) {
  if (!value || !UUID.test(value.workspaceId || "")
      || typeof value.accessToken !== "string" || !value.accessToken
      || typeof value.refreshToken !== "string" || !value.refreshToken
      || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)
      || typeof value.email !== "string" || value.email.length > 320
      || typeof value.workspaceName !== "string" || value.workspaceName.length > 200) {
    throw new Error("The Sherry account connection is incomplete.");
  }
  return { workspaceId: value.workspaceId, accessToken: value.accessToken,
    refreshToken: value.refreshToken, expiresAt: value.expiresAt,
    email: value.email, workspaceName: value.workspaceName };
}

export async function refreshConnection(state, store, fetchImpl = fetch, now = Date.now()) {
  const connection = state.connection;
  if (!connection) return null;
  if (connection.expiresAt * 1000 > now + 120_000) return connection;
  if (now < nextRefreshAttemptAt) return null;
  let response;
  try {
    response = await fetchImpl(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST", headers: { apikey: SUPABASE_KEY, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: connection.refreshToken }),
      signal: AbortSignal.timeout(8_000)
    });
  } catch {
    nextRefreshAttemptAt = now + 30_000;
    state.lastError = "Account refresh is offline; encrypted batches remain queued.";
    await store.save(state);
    return null;
  }
  if (!response.ok) {
    nextRefreshAttemptAt = now + 60_000;
    state.lastError = "Sherry account session expired. Sign in again to resume upload.";
    await store.save(state);
    return null;
  }
  const next = await response.json();
  state.connection = validateConnection({ ...connection, accessToken: next.access_token,
    refreshToken: next.refresh_token, expiresAt: next.expires_at });
  nextRefreshAttemptAt = 0;
  await store.save(state);
  return state.connection;
}
