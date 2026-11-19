package dev.sherry.capture

import android.accessibilityservice.AccessibilityService
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import dev.sherry.capture.core.*
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class NativePreview(val id: String, val messages: List<ParsedMessage>, val observedAt: String,
                         val appVersion: String, val sessionId: String? = null)

/** Requested previews and opt-in foreground ChatGPT capture share one versioned screen reader. */
class CaptureAccessibilityService : AccessibilityService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val store get() = (application as SherryApplication).store
    private var request: Job? = null
    private var automatic: Job? = null
    private var expiry: Job? = null
    private var previewCurrent = false
    private var configuredForChatGpt: Boolean? = null
    private val changes = Channel<Unit>(Channel.CONFLATED)
    private val allowed get() = Provider.CHATGPT in store.state.value.proofProviders && store.storageError == null
    private val automaticAllowed get() = allowed && store.state.value.captureEnabled

    override fun onServiceConnected() {
        instance = this
        connected.value = true
        probe.value = "Ready. Start a ChatGPT preview from Capture."
        scope.launch {
            store.state.collect {
                if (configuredForChatGpt != allowed) {
                    serviceInfo = serviceInfo.apply {
                        packageNames = arrayOf(if (allowed) Provider.CHATGPT.packageName else packageName)
                    }
                    configuredForChatGpt = allowed
                }
                if (!allowed) {
                    clear("ChatGPT preview is paused or disabled.")
                    stopAutomatic("ChatGPT capture is off.")
                } else if (automaticAllowed) startAutomatic()
                else stopAutomatic("Automatic capture is off.")
            }
        }
    }

    private fun startRead(sessionId: String?): Boolean {
        if (!allowed || automaticAllowed) return false
        clear("Open the ChatGPT conversation. Sherry will refresh the preview as the screen settles.")
        request = scope.launch {
            val version = runCatching { packageManager.getPackageInfo(Provider.CHATGPT.packageName, 0).versionName.orEmpty() }.getOrDefault("")
            val deadline = SystemClock.elapsedRealtime() + 300_000
            var previous: List<ParsedMessage>? = null
            var since = 0L
            var accepted: List<ParsedMessage>? = null
            var lastRead = 0L
            try {
                while (allowed && SystemClock.elapsedRealtime() < deadline) {
                    val wait = 250 - (SystemClock.elapsedRealtime() - lastRead)
                    if (wait > 0) delay(wait)
                    val read = withContext(Dispatchers.IO) {
                        val root = rootInActiveWindow ?: return@withContext null
                        try {
                            if (root.packageName?.toString() != Provider.CHATGPT.packageName) null
                            else ChatGptScreenReader.read(root).let { ChatGptParser.parse(it.root, version, it.complete) }
                        } finally { @Suppress("DEPRECATION") root.recycle() }
                    }
                    lastRead = SystemClock.elapsedRealtime()
                    ensureActive()
                    if (!allowed) return@launch
                    if (read?.recognized == true) {
                        if (previous != read.messages) {
                            previous = read.messages
                            since = SystemClock.elapsedRealtime()
                            previewCurrent = false
                        }
                        if (SystemClock.elapsedRealtime() - since >= 750 && accepted != read.messages) {
                            previewState.value = NativePreview(UUID.randomUUID().toString(), read.messages, Instant.now().toString(), version, sessionId)
                            accepted = read.messages
                            previewCurrent = true
                            probe.value = "${read.messages.size} visible messages updated. Return to Sherry to review and save."
                        } else if (accepted != read.messages) {
                            probe.value = "Recognized ${read.messages.size} messages. Checking that the screen has settled…"
                        } else {
                            previewCurrent = true
                        }
                    } else {
                        previous = null
                        previewCurrent = false
                        probe.value = read?.issue ?: if (previewState.value == null)
                            "Open your ChatGPT conversation to read visible messages."
                        else "The last settled preview is available. New changes are not ready yet."
                    }
                    withTimeoutOrNull(350) { changes.receive() }
                }
                if (previewState.value == null) probe.value = "Reading timed out. Open a supported ChatGPT conversation and try again."
                else {
                    probe.value = if (previewCurrent) "Preview ready. Return to Sherry to review and save."
                        else "The latest screen was not settled. Review the earlier preview for missing text."
                    expirePreview()
                }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { probe.value = "Could not read this screen. Your saved captures are unchanged." }
        }
        return true
    }

    private fun finishRead() {
        if (request?.isActive != true) return
        request?.cancel(); request = null
        if (previewState.value == null) probe.value = "No settled messages were found. Try again after ChatGPT finishes loading."
        else {
            probe.value = if (previewCurrent) "${previewState.value!!.messages.size} visible messages ready. Review before saving."
                else "The latest screen was not settled. Review this earlier preview for missing text before saving."
            expirePreview()
        }
    }

    private fun expirePreview() {
        expiry?.cancel()
        expiry = scope.launch { delay(120_000); clear("Preview expired. Read ChatGPT again to review its current messages.") }
    }

    private fun startAutomatic() {
        if (automatic?.isActive == true) return
        clear("Automatic ChatGPT capture is on. Open ChatGPT and use it normally.")
        automaticStatus.value = "Watching for ChatGPT. Settled messages save on this phone automatically."
        automatic = scope.launch {
            val engine = AutomaticCaptureEngine(store)
            var lastRead = 0L
            while (automaticAllowed) {
                try {
                    val wait = 100 - (SystemClock.elapsedRealtime() - lastRead)
                    if (wait > 0) delay(wait)
                    lastRead = SystemClock.elapsedRealtime()
                    val step = withContext(Dispatchers.IO) {
                        val root = rootInActiveWindow
                        try {
                            if (root?.packageName?.toString() != Provider.CHATGPT.packageName) {
                                engine.observe(null, "", SystemClock.elapsedRealtime(), Instant.now().toString())
                            } else {
                                val contextBeforeRead = store.state.value.automaticContext?.id
                                val retainedBefore = store.state.value.pendingNativeObservations.size
                                val readStarted = SystemClock.elapsedRealtime()
                                val read = ChatGptScreenReader.read(root)
                                val readFinished = SystemClock.elapsedRealtime()
                                val version = runCatching { packageManager.getPackageInfo(Provider.CHATGPT.packageName, 0).versionName.orEmpty() }.getOrDefault("")
                                ensureActive()
                                val step = engine.observe(read.root, version, SystemClock.elapsedRealtime(), Instant.now().toString(), read.complete, contextBeforeRead)
                                val finished = SystemClock.elapsedRealtime()
                                val retainedNow = store.state.value.pendingNativeObservations.size
                                if (step.added > 0 || retainedNow != retainedBefore || readFinished - readStarted > 1000) {
                                    // Counts/timings only; no source text, identities or credentials.
                                    Log.i("SherryCaptureTiming", "read_end_ms=$readFinished read_ms=${readFinished-readStarted} process_ms=${finished-readFinished} new_records=${step.added} retained_reads=$retainedNow")
                                }
                                step
                            }
                        } finally { @Suppress("DEPRECATION") root?.recycle() }
                    }
                    ensureActive()
                    automaticStatus.value = step.status
                    if (step.added > 0 && store.state.value.connection != null) SyncScheduler.enqueue(applicationContext)
                    withTimeoutOrNull(step.nextReadAfterMs) { changes.receive() }
                } catch (error: CancellationException) { throw error }
                catch (_: Exception) {
                    automaticStatus.value = engine.readFailed().status
                    delay(2000)
                }
            }
        }
    }

    private fun stopAutomatic(message: String) {
        automatic?.cancel(); automatic = null
        automaticStatus.value = message
    }

    private fun clear(message: String) {
        request?.cancel(); request = null
        expiry?.cancel(); expiry = null
        previewState.value = null
        previewCurrent = false
        probe.value = message
    }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.packageName?.toString() == Provider.CHATGPT.packageName &&
            (request?.isActive == true || automatic?.isActive == true)) {
            previewCurrent = false
            changes.trySend(Unit)
        }
    }
    override fun onInterrupt() { clear("Android interrupted the preview. Try again.") }
    override fun onDestroy() {
        clear("Accessibility service is off.")
        stopAutomatic("Accessibility service is off.")
        scope.cancel()
        if (instance === this) instance = null
        connected.value = false
        super.onDestroy()
    }
    companion object {
        private var instance: CaptureAccessibilityService? = null
        private val connected = MutableStateFlow(false)
        val isConnected = connected.asStateFlow()
        private val probe = MutableStateFlow("Enable the ChatGPT preview in Settings.")
        val status = probe.asStateFlow()
        private val previewState = MutableStateFlow<NativePreview?>(null)
        val preview = previewState.asStateFlow()
        private val automaticStatus = MutableStateFlow("Automatic capture is off.")
        val automaticCaptureStatus = automaticStatus.asStateFlow()
        fun requestPreview(sessionId: String? = null): Boolean = instance?.startRead(sessionId) ?: false
        fun finishActiveRead() { instance?.finishRead() }
        fun clearAutomaticIssue() { automaticStatus.value = "Watching for ChatGPT. Open the separate conversation to capture it." }
        fun discardPreview() { instance?.clear("Preview cleared. Nothing new was saved.") }
        fun consumePreview(id: String) {
            if (previewState.value?.id == id) instance?.clear("Visible messages saved. Read again for a new snapshot.")
        }
    }
}
