import { uploadReceiptError } from "../extension/src/upload-receipt.js";
import { batchNeedsSourceMetadata, captureServerCapabilities, supportsFrozenBatchMetadata } from "./source-metadata.js";
import { updateCaptureDelivery } from "./capture-log.js";

export function ingestionEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:"
    && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("The ingestion endpoint must use HTTPS, except for localhost development.");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("The ingestion URL must not contain credentials, a query, or a fragment.");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/capture/batches`
    .replace(/\/v1\/capture\/batches\/v1\/capture\/batches$/, "/v1/capture/batches");
  return url.toString();
}

function retryDelay(attempts) {
  return Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.min(Math.max(attempts - 1, 0), 6)));
}

export async function uploadPending(state, store, {
  endpoint, accessToken, now = () => new Date(), fetchImpl = fetch,
  isEnabled = async () => true
}) {
  if (!endpoint || !accessToken) return { uploaded: 0, status: "needs_connection" };
  const url = ingestionEndpoint(endpoint);
  let uploaded = 0;
  let checkedCapabilities = null;
  let capabilitiesExpireAt = 0;
  while (state.pending.length) {
    if (!(await isEnabled())) return { uploaded, status: "paused" };
    const item = state.pending[0];
    if (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > now().getTime()) break;
    if (batchNeedsSourceMetadata(item.batch)) {
      // Construction-time support cannot authorize a later frozen retry after
      // rollback. Refresh once per upload run, reusing it for at most one minute.
      if (!checkedCapabilities || now().getTime() >= capabilitiesExpireAt) {
        checkedCapabilities = await captureServerCapabilities(url, {
          fetchImpl, now: () => now().getTime(), forceRefresh: true
        });
        capabilitiesExpireAt = now().getTime() + 60_000;
      }
      if (!supportsFrozenBatchMetadata(item.batch, checkedCapabilities)) {
        item.attempts += 1;
        item.nextAttemptAt = new Date(now().getTime() + retryDelay(item.attempts)).toISOString();
        state.lastError = "Sherry has not confirmed support for this saved capture's metadata. The unchanged encrypted batch will retry.";
        updateCaptureDelivery(state, item, "retrying", { error: state.lastError });
        await store.save(state);
        return { uploaded, status: "retry" };
      }
      if (!(await isEnabled())) return { uploaded, status: "paused" };
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "idempotency-key": item.batch.batchId
        },
        body: JSON.stringify(item.batch),
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      item.attempts += 1;
      item.nextAttemptAt = new Date(now().getTime() + retryDelay(item.attempts)).toISOString();
      state.lastError = "Upload network error; the unchanged encrypted batch will be retried.";
      updateCaptureDelivery(state, item, "retrying", { error: state.lastError });
      await store.save(state);
      return { uploaded, status: "retry" };
    }
    if (response.ok) {
      const receipt = await response.json().catch(() => null);
      const receiptError = uploadReceiptError(item.batch, receipt);
      if (receiptError) {
        item.attempts += 1;
        item.nextAttemptAt = new Date(now().getTime() + retryDelay(item.attempts)).toISOString();
        state.lastError = receiptError;
        updateCaptureDelivery(state, item, "retrying", { error: receiptError, httpStatus: response.status });
        await store.save(state);
        return { uploaded, status: "retry" };
      }
      state.pending.shift();
      state.lastUploadAt = now().toISOString();
      updateCaptureDelivery(state, item, "uploaded", { uploadedAt: state.lastUploadAt, httpStatus: response.status });
      state.lastError = null;
      uploaded += 1;
      await store.save(state);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      item.nextAttemptAt = new Date(now().getTime() + 60_000).toISOString();
      state.lastError = response.status === 401
        ? "The Sherry session expired; reconnect before upload can continue."
        : "The Sherry account cannot write to this workspace.";
      updateCaptureDelivery(state, item, "blocked", { error: state.lastError, httpStatus: response.status });
      await store.save(state);
      return { uploaded, status: "account_blocked" };
    }
    if ([400, 409, 413, 422].includes(response.status)) {
      if (state.quarantined.length >= 50) {
        state.lastError = "Quarantine is full; upload stopped without dropping the batch.";
        updateCaptureDelivery(state, item, "blocked", { error: state.lastError, httpStatus: response.status });
        await store.save(state);
        return { uploaded, status: "quarantine_full" };
      }
      state.quarantined.push({ ...state.pending.shift(), status: response.status });
      state.lastError = `A capture batch was quarantined after HTTP ${response.status}.`;
      updateCaptureDelivery(state, item, "rejected", { error: state.lastError, httpStatus: response.status });
      await store.save(state);
      continue;
    }
    item.attempts += 1;
    item.nextAttemptAt = new Date(now().getTime() + retryDelay(item.attempts)).toISOString();
    state.lastError = `Upload returned HTTP ${response.status}; the unchanged batch will be retried.`;
    updateCaptureDelivery(state, item, "retrying", { error: state.lastError, httpStatus: response.status });
    await store.save(state);
    return { uploaded, status: "retry" };
  }
  return { uploaded, status: "ready" };
}
