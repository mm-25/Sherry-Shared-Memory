package dev.sherry.capture.core

import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

val CaptureJson = Json { encodeDefaults = true; ignoreUnknownKeys = true }

@Serializable
enum class Provider(val wire: String, val family: String, val label: String, val packageName: String) {
    CHATGPT("chatgpt", "openai", "ChatGPT", "com.openai.chatgpt"),
    GEMINI("gemini", "google", "Gemini", "com.google.android.apps.bard"),
    CLAUDE("claude", "anthropic", "Claude", "com.anthropic.claude");
}

@Serializable
data class CaptureEvent(
    val eventId: String,
    val provider: String,
    val conversationId: String,
    val providerMessageId: String? = null,
    val sequence: Int,
    val role: String,
    val text: String,
    val contentHash: String,
    val sourceUrl: String? = null,
    val sourceLocator: String,
    val chatTitle: String,
    val messageTimestamp: String? = null,
    val capturedAt: String,
    val links: List<String> = emptyList(),
    val attachments: List<JsonObject> = emptyList(),
    val captureEvidence: CaptureEvidence? = null,
    // Absent in older saved records. Never reconstruct evidence while freezing/retrying them.
    val sourceMetadata: SourceMetadata? = null,
)

/** Evidence collected by this reader, separate from display values and local IDs. */
@Serializable
data class SourceMetadata(
    val version: Int = 1,
    val titleBasis: String,
    val conversationIdentity: String = "local",
    val messageIdentity: String = "local",
    val timestampBasis: String = "observed",
    // Empty arrays do not establish that a provider conversation had no links or files.
    val linksStatus: String = "not_inspected",
    val attachmentsStatus: String = "not_inspected",
)

@Serializable
data class CaptureClient(
    val type: String = "share",
    val adapterVersion: String = "0.1.0",
    val deviceId: String,
    val os: String = "android",
    val appVersion: String? = null,
    val captureSessionId: String,
)

@Serializable
data class Coverage(val state: String = "partial", val gapBefore: Boolean = true, val backfillAvailable: Boolean = false)

@Serializable
data class CaptureBatch(
    val batchId: String,
    val workspaceId: String,
    val provider: String,
    val providerFamily: String,
    val product: String = provider,
    val surface: String = "android",
    val schemaVersion: Int = 2,
    val reason: String = "share",
    val clientCreatedAt: String,
    val captureClient: CaptureClient,
    val coverage: Coverage = Coverage(),
    val events: List<CaptureEvent>,
)

@Serializable
data class LocalCapture(
    val id: String,
    val provider: Provider,
    val createdAt: String,
    val event: CaptureEvent,
    val status: String = "pending",
    // Once assigned, the complete serialized request is immutable across retries.
    val payload: String? = null,
    val message: String? = null,
    val reason: String = "share",
    val captureSessionId: String = id,
    val providerAppVersion: String? = null,
)

object CaptureFactory {
    const val MAX_TEXT = 60_000
    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")

    fun validWorkspace(value: String) = uuid.matches(value)
    fun hash(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun share(provider: Provider, text: String, title: String, role: String = "unknown",
              now: String = Instant.now().toString(), id: String = UUID.randomUUID().toString()): LocalCapture {
        val cleanText = text.trim()
        require(cleanText.isNotBlank()) { "Add text to capture." }
        require(cleanText.length <= MAX_TEXT) { "This share is too large. Share a smaller excerpt (up to 60,000 characters)." }
        require(title.trim().length in 1..200) { "Add a title of up to 200 characters." }
        require(role in setOf("user", "assistant", "unknown")) { "Choose who wrote this excerpt." }
        // A shared fragment is not evidence of a complete conversation or a canonical provider ID.
        val locator = "android-share:$id"
        val event = CaptureEvent("evt_${hash(id)}", provider.wire, locator, sequence = 0,
            role = role, text = cleanText, contentHash = hash(cleanText), sourceLocator = locator,
            chatTitle = title.trim(), capturedAt = now, sourceUrl = providerLink(provider, cleanText),
            sourceMetadata = SourceMetadata(titleBasis = "user"))
        return LocalCapture(id, provider, now, event)
    }

    fun providerLink(provider: Provider, text: String): String? {
        val url = runCatching { URI(text) }.getOrNull() ?: return null
        val hosts = when (provider) {
            Provider.CHATGPT -> setOf("chatgpt.com", "chat.openai.com")
            Provider.GEMINI -> setOf("gemini.google.com")
            Provider.CLAUDE -> setOf("claude.ai")
        }
        return text.takeIf { url.scheme == "https" && url.host?.lowercase() in hosts && url.userInfo == null && text.length <= 4096 }
    }

    fun freeze(capture: LocalCapture, workspace: String, deviceId: String): LocalCapture {
        require(validWorkspace(workspace)) { "Enter a valid workspace ID." }
        require(deviceId.length >= 8)
        if (capture.payload != null) {
            require(CaptureJson.decodeFromString<CaptureBatch>(capture.payload).workspaceId == workspace) {
                "This capture is already assigned to another workspace."
            }
            return capture
        }
        val batch = CaptureBatch(capture.id, workspace, capture.provider.wire, capture.provider.family,
            reason = capture.reason,
            clientCreatedAt = capture.createdAt,
            captureClient = CaptureClient(type = if (capture.reason == "accessibility") "accessibility" else "share",
                adapterVersion = if (capture.event.captureEvidence != null) "0.1.2" else if (capture.reason == "accessibility") "0.1.1" else "0.1.0",
                deviceId = deviceId, captureSessionId = capture.captureSessionId, appVersion = capture.providerAppVersion),
            events = listOf(capture.event))
        val payload = CaptureJson.encodeToString(batch)
        require(payload.toByteArray().size <= 524_288) { "Capture exceeds the upload size limit." }
        return capture.copy(payload = payload)
    }

    fun nativeTurn(session: NativeSession, turn: NativeTurn, message: ParsedMessage,
                   observationId: String, appVersion: String, now: String): LocalCapture {
        require(validWorkspace(session.id) && validWorkspace(observationId))
        require(ChatGptParser.validVersionMetadata(appVersion)) { "ChatGPT app version metadata is missing or invalid." }
        val locator = "android-session:${session.id}"
        val id = UUID.nameUUIDFromBytes("${session.id}:${turn.id}".toByteArray()).toString()
        val event = CaptureEvent("evt_${hash(turn.id)}", "chatgpt", locator, sequence = turn.sequence,
            role = message.role, text = message.text, contentHash = hash(message.text), sourceLocator = locator,
            chatTitle = "ChatGPT captured conversation", capturedAt = now,
            captureEvidence = CaptureEvidence(completeness = message.completeness),
            sourceMetadata = SourceMetadata(titleBasis = "generic"))
        return LocalCapture(id, Provider.CHATGPT, now, event, reason = "accessibility",
            captureSessionId = observationId, providerAppVersion = appVersion)
    }

    fun nativeSnapshot(messages: List<ParsedMessage>, sessionId: String, appVersion: String,
                       now: String = Instant.now().toString()): List<LocalCapture> {
        require(messages.isNotEmpty() && messages.size <= 100)
        require(validWorkspace(sessionId)) { "The capture session must have a UUID." }
        require(ChatGptParser.validVersionMetadata(appVersion)) { "ChatGPT app version metadata is missing or invalid." }
        val locator = "android-chatgpt:$sessionId"
        return messages.mapIndexed { index, message ->
            require(message.role in setOf("user", "assistant") && message.text.isNotBlank() && message.text.length <= MAX_TEXT)
            val id = UUID.nameUUIDFromBytes("$sessionId:$index".toByteArray()).toString()
            val event = CaptureEvent("evt_${hash("$sessionId:$index")}", "chatgpt", locator,
                sequence = index, role = message.role, text = message.text, contentHash = hash(message.text),
                sourceLocator = locator, chatTitle = "ChatGPT visible conversation", capturedAt = now,
                sourceMetadata = SourceMetadata(titleBasis = "generic"))
            LocalCapture(id, Provider.CHATGPT, now, event, reason = "accessibility",
                captureSessionId = sessionId, providerAppVersion = appVersion)
        }
    }
}

enum class UploadDecision { COMMITTED, RETRY, AUTH_REQUIRED, REJECTED }

enum class Acknowledgement { COMMITTED, PREVIOUSLY_DELETED, UNCONFIRMED }

fun acknowledgement(body: String?, batchId: String, eventCount: Int): Acknowledgement = runCatching {
    val value = CaptureJson.parseToJsonElement(body ?: "").jsonObject
    if (value["ok"]?.jsonPrimitive?.booleanOrNull != true || value["batchId"]?.jsonPrimitive?.contentOrNull != batchId) {
        Acknowledgement.UNCONFIRMED
    } else if (eventCount > 0 && value["ignoredDeletedEvents"]?.jsonPrimitive?.intOrNull == eventCount) {
        Acknowledgement.PREVIOUSLY_DELETED
    } else {
        val result = value["result"]?.jsonObject ?: return@runCatching Acknowledgement.UNCONFIRMED
        if (eventCount <= 0 || result["status"]?.jsonPrimitive?.contentOrNull != "committed") {
            return@runCatching Acknowledgement.UNCONFIRMED
        }
        val counts = listOf("received", "inserted", "updated", "duplicates").map { key ->
            val primitive = result[key]?.jsonPrimitive ?: return@runCatching Acknowledgement.UNCONFIRMED
            val count = primitive.doubleOrNull
            // Each nonnegative outcome is bounded by the submitted total. This
            // also keeps summation exact and prevents integer overflow.
            if (primitive.isString || count == null || !count.isFinite() || count < 0
                || count > eventCount.toDouble() || count % 1.0 != 0.0) {
                return@runCatching Acknowledgement.UNCONFIRMED
            }
            count.toLong()
        }
        if (counts[0] == eventCount.toLong() && counts.drop(1).sum() == counts[0]) {
            Acknowledgement.COMMITTED
        } else Acknowledgement.UNCONFIRMED
    }
}.getOrDefault(Acknowledgement.UNCONFIRMED)

fun uploadDecision(status: Int, committed: Boolean): UploadDecision = when {
    status in 200..299 && committed -> UploadDecision.COMMITTED
    status == 401 || status == 403 -> UploadDecision.AUTH_REQUIRED
    status == 408 || status == 429 || status >= 500 || status in 200..299 -> UploadDecision.RETRY
    else -> UploadDecision.REJECTED
}

/** Future native adapters must supply verified identities/roles, not whole-screen text. */
data class ObservedTurn(val conversationId: String, val messageId: String, val role: String,
                        val text: String, val isStreaming: Boolean, val isEditable: Boolean = false)

class StableTurnGate(private val settleMillis: Long = 1800) {
    private data class Pending(val turn: ObservedTurn, val since: Long)
    private val pending = mutableMapOf<String, Pending>()
    private val emitted = mutableMapOf<String, String>()

    fun observe(turn: ObservedTurn, now: Long): ObservedTurn? {
        if (turn.conversationId.isBlank() || turn.messageId.isBlank()) return null
        val key = "${turn.conversationId}\u0000${turn.messageId}"
        if (turn.isEditable || turn.isStreaming || turn.role !in setOf("user", "assistant") || turn.text.isBlank()) {
            pending.remove(key)
            return null
        }
        val previous = pending[key]
        if (previous?.turn != turn) {
            if (pending.size >= 1000) pending.clear()
            pending[key] = Pending(turn, now)
            return null
        }
        if (now - previous.since < settleMillis) return null
        val revision = CaptureFactory.hash("${turn.role}\u0000${turn.text}")
        if (emitted[key] == revision) return null
        if (emitted.size >= 1000) emitted.clear()
        emitted[key] = revision
        return turn
    }

    fun reset() { pending.clear(); emitted.clear() }
}

/** Do not send evidence-bearing captures to a server that would silently discard their metadata. */
fun supportsCaptureEvidence(body: String?): Boolean = runCatching {
    val value = CaptureJson.parseToJsonElement(body ?: "").jsonObject
    value["ok"]?.jsonPrimitive?.booleanOrNull == true &&
        value["captureEvidenceVersion"]?.jsonPrimitive?.intOrNull == 1
}.getOrDefault(false)

fun supportsSourceMetadata(body: String?): Boolean = runCatching {
    val value = CaptureJson.parseToJsonElement(body ?: "").jsonObject
    val version = value["sourceMetadataVersion"]?.jsonPrimitive
    value["ok"]?.jsonPrimitive?.booleanOrNull == true &&
        version != null && !version.isString && version.intOrNull == 1
}.getOrDefault(false)

/** Check the frozen request, not a potentially newer local display record. */
fun supportsCaptureBatchMetadata(batch: CaptureBatch, body: String?): Boolean =
    (batch.events.none { it.captureEvidence != null } || supportsCaptureEvidence(body)) &&
        (batch.events.none { it.sourceMetadata != null } || supportsSourceMetadata(body))
