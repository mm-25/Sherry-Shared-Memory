package dev.sherry.capture.core

import java.net.URI
import java.time.Instant
import kotlinx.serialization.Serializable

/** The old pause controlled both readers and delivery. Upgrades must preserve its effective state. */
fun captureMasterEnabled(automatic: Boolean, deliveryPaused: Boolean, controlVersion: Int): Boolean =
    automatic && (controlVersion >= 1 || !deliveryPaused)

@Serializable
data class RecentCapture(
    val id: String,
    val provider: Provider,
    val conversationId: String,
    val title: String,
    val role: String,
    val text: String,
    val capturedAt: String,
    val workspaceId: String? = null,
    val delivery: String = "pending",
    val sequence: Int = 0,
)

private fun recentCaptureTime(row: RecentCapture): Instant =
    runCatching { Instant.parse(row.capturedAt) }.getOrDefault(Instant.MIN)

/** Test is an inspection feed: newest conversation activity and source turns appear first. */
fun recentConversationGroups(rows: List<RecentCapture>): List<List<RecentCapture>> =
    rows.groupBy { it.conversationId }.values.sortedWith(
        compareByDescending<List<RecentCapture>> { group -> group.maxOf(::recentCaptureTime) }
            .thenBy { group -> group.first().conversationId })
        .map { group -> group.sortedWith(compareByDescending<RecentCapture> { it.sequence }
            .thenByDescending(::recentCaptureTime).thenBy { it.id }) }

/** Recent UI history is separate from delivery payloads and never holds a second immutable request. */
fun rememberRecent(previous: List<RecentCapture>, captures: List<LocalCapture>, workspaceId: String?): List<RecentCapture> {
    val rows = LinkedHashMap<String, RecentCapture>()
    previous.forEach { rows[it.id] = it }
    captures.forEach { c ->
        val old = rows[c.id]
        rows[c.id] = RecentCapture(c.id, c.provider, c.event.conversationId, c.event.chatTitle, c.event.role,
            c.event.text, c.event.capturedAt, old?.workspaceId ?: workspaceId, old?.delivery ?: c.status, c.event.sequence)
    }
    val bounded = ArrayDeque<RecentCapture>()
    var bytes = 0
    // Legacy waiting records can be projected after today's captures. Arrival in
    // this map must not make them newer or evict more recently captured text.
    rows.values.sortedBy(::recentCaptureTime).takeLast(50).forEach { row ->
        val size = row.text.toByteArray(Charsets.UTF_8).size
        bounded.addLast(row); bytes += size
        while (bytes > 2_000_000 && bounded.isNotEmpty()) bytes -= bounded.removeFirst().text.toByteArray(Charsets.UTF_8).size
    }
    return bounded.toList()
}

const val SHERRY_WEBSITE = "https://shared-memory-ingestion.mufaddal-m25.workers.dev"
fun trustedWebsiteUrl(value: String): Boolean = runCatching {
    val uri = URI(value)
    uri.scheme == "https" && uri.host == URI(SHERRY_WEBSITE).host && uri.userInfo == null &&
        (uri.port == -1 || uri.port == 443)
}.getOrDefault(false)
