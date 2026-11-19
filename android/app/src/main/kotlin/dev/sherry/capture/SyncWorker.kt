package dev.sherry.capture

import android.app.Application
import android.content.Context
import androidx.work.*
import dev.sherry.capture.core.*
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CancellationException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

open class SherryApplication : Application() {
    val store: CaptureStore by lazy { CaptureStore(this) }
    val accountManager: AccountManager by lazy { AccountManager(store) }
    override fun onCreate() {
        super.onCreate()
        // Recover the gap between a durable save and scheduling, including process termination.
        SyncScheduler.recover(this)
    }
}

object SyncScheduler {
    private fun request() = OneTimeWorkRequestBuilder<SyncWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()

    fun enqueue(context: Context) = WorkManager.getInstance(context)
        .enqueueUniqueWork("capture-sync", ExistingWorkPolicy.APPEND_OR_REPLACE, request())

    fun recover(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork("capture-sync", ExistingWorkPolicy.KEEP, request())
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("capture-recovery", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }

    fun cancel(context: Context) = WorkManager.getInstance(context).cancelUniqueWork("capture-sync")
}

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val store = (applicationContext as SherryApplication).store
        if (store.storageError != null) return@withContext Result.failure()
        try {
            var supportedMetadata: String? = null
            var refreshAfterDenial = false
            repeat(100) {
                if (store.state.value.paused) return@withContext Result.success()
                store.reconcileRetainedObservations()
                if (store.state.value.captures.none { it.status == "pending" }) return@withContext Result.success()
                val connection = (applicationContext as SherryApplication).accountManager.current(refreshAfterDenial)
                    ?: return@withContext Result.success()
                val (_, capture) = store.nextUpload() ?: return@withContext Result.success()
                if (isStopped) return@withContext Result.success()
                val batch = CaptureJson.decodeFromString<CaptureBatch>(capture.payload!!)
                if (!supportsCaptureBatchMetadata(batch, supportedMetadata)) {
                    val capabilityRequest = Request.Builder().url("$WORKER_URL/health").get().build()
                    client.newCall(capabilityRequest).execute().use { response ->
                        supportedMetadata = if (response.isSuccessful) response.peekBody(16_384).string() else null
                    }
                    if (!supportsCaptureBatchMetadata(batch, supportedMetadata)) {
                        store.status("These captures are safe on this phone. Sync is waiting for Sherry's mobile metadata update.")
                        return@withContext Result.retry()
                    }
                }
                val request = Request.Builder().url("$WORKER_URL/v1/capture/batches")
                    .header("Authorization", "Bearer ${connection.accessToken}")
                    .header("Idempotency-Key", capture.id)
                    .post(capture.payload!!.toRequestBody("application/json".toMediaType())).build()
                // Pausing stops subsequent requests; an already accepted request cannot be recalled.
                if (store.state.value.paused || store.state.value.connection != connection) return@withContext Result.success()
                client.newCall(request).execute().use { response ->
                    val body = response.body?.source()?.let { source ->
                        source.request(65_537)
                        if (source.buffer.size > 65_536) null else source.buffer.clone().readUtf8()
                    }
                    val ack = acknowledgement(body, capture.id, 1)
                    if (response.isSuccessful && ack == Acknowledgement.PREVIOUSLY_DELETED) {
                        store.reject(capture.id, "Sherry did not accept this capture because of an earlier deletion. Its saved copy was kept for review.")
                        return@use
                    }
                    when (uploadDecision(response.code, ack == Acknowledgement.COMMITTED)) {
                        UploadDecision.COMMITTED -> { store.committed(capture.id); refreshAfterDenial = false }
                        UploadDecision.AUTH_REQUIRED -> {
                            if (!refreshAfterDenial) { refreshAfterDenial = true; return@use }
                            (applicationContext as SherryApplication).accountManager.requireReconnect(connection)
                            return@withContext Result.success()
                        }
                        UploadDecision.REJECTED -> store.reject(capture.id,
                            "Sherry rejected this capture (HTTP ${response.code}). It was kept locally; it will not retry automatically.")
                        UploadDecision.RETRY -> {
                            store.status("Sherry could not confirm this upload. The same capture will retry when available.")
                            return@withContext Result.retry()
                        }
                    }
                }
            }
            if (!store.state.value.paused && store.state.value.captures.any { it.status == "pending" }) SyncScheduler.enqueue(applicationContext)
            Result.success()
        } catch (_: AccountRequiredException) {
            store.status("Sign in to Sherry again. Waiting messages are safe on this phone.")
            Result.success()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            runCatching { store.status("Sync is unavailable. Pending captures remain encrypted and will retry.") }
            Result.retry()
        }
    }

    companion object {
        const val WORKER_URL = "https://shared-memory-ingestion.mufaddal-m25.workers.dev"
        private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .callTimeout(25, TimeUnit.SECONDS).build()
    }
}
