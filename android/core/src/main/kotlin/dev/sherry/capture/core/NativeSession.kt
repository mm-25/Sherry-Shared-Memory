package dev.sherry.capture.core

import java.util.UUID
import kotlinx.serialization.Serializable

@Serializable
data class CaptureEvidence(
    val version: Int = 1,
    val conversationIdentity: String = "local_session",
    val messageIdentity: String = "local_sequence",
    val timestampBasis: String = "observed",
    val orderBasis: String = "session_sequence",
    val completeness: String = "unknown",
    val titleBasis: String = "placeholder",
)

/** Durable fingerprints survive successful upload without retaining a second plaintext history. */
@Serializable
data class NativeTurn(val id: String, val role: String, val hash: String, val sequence: Int,
                      val completeness: String = "unknown")

@Serializable
data class NativeSession(val id: String, val createdAt: String, val lastObservedAt: String,
                         val turns: List<NativeTurn> = emptyList(), val workspaceId: String? = null)

data class SessionMerge(val session: NativeSession, val additions: List<Pair<NativeTurn, ParsedMessage>>,
                        val duplicates: Int)

/** Text never identifies a different chat; callers must provide a trusted local session. */
object NativeReconciler {
    fun merge(session: NativeSession, messages: List<ParsedMessage>, observedAt: String,
              allowSingleTrailingAnchor: Boolean = false): SessionMerge {
        require(messages.size in 1..100)
        require(messages.all { it.role in setOf("user", "assistant") && it.text.isNotBlank() && it.text.length <= CaptureFactory.MAX_TEXT })
        val keys = messages.map { it.role to CaptureFactory.hash(it.text) }
        val old = session.turns.sortedBy { it.sequence }
        val firstSequence: Int
        if (old.isEmpty()) firstSequence = 500_000
        else {
            // Manual reads need two distinct anchors. A continuous foreground observer may
            // append from one exact last-turn anchor only when it verified the prior screen.
            val matches = mutableListOf<Int>()
            for (offset in (-(messages.size - 1)) until old.size) {
                val start = maxOf(0, offset)
                val end = minOf(old.size, offset + messages.size)
                if (end - start < (if (allowSingleTrailingAnchor) 1 else 2)) continue
                val overlap = (start until end)
                if (overlap.any { i -> (old[i].role to old[i].hash) != keys[i - offset] }) continue
                val anchors = overlap.filter { i -> old[i].completeness != "possibly_clipped" && messages[i - offset].completeness != "possibly_clipped" }
                // Continuous foreground evidence refers to the saved tail. Matching an
                // earlier repeated prefix cannot be used to relocate that live append.
                if (allowSingleTrailingAnchor && old.lastIndex !in anchors) continue
                val distinctAnchors = anchors.map { old[it].role to old[it].hash }.distinct().size
                val oneTrailingAnchor = allowSingleTrailingAnchor && anchors.size == 1 &&
                    anchors.single() == old.lastIndex && end == old.size && offset + messages.size >= old.size
                if (distinctAnchors < 2 && !oneTrailingAnchor) continue
                matches += offset
            }
            require(matches.size == 1) {
                if (matches.isEmpty()) "Cannot safely join this read. Keep at least two previously saved, distinct messages in view, or start a separate capture. Changed or clipped messages are not stitched automatically."
                else "Repeated messages make this overlap ambiguous. Show more surrounding messages or start a separate capture."
            }
            firstSequence = old.first().sequence + matches.single()
        }
        require(firstSequence >= 0 && firstSequence + messages.size - 1 <= 1_000_000)
        val bySequence = old.associateBy { it.sequence }
        val additions = messages.mapIndexedNotNull { index, message ->
            val sequence = firstSequence + index
            if (bySequence.containsKey(sequence)) null
            else NativeTurn(UUID.randomUUID().toString(), message.role, keys[index].second, sequence, message.completeness) to message
        }
        require(old.size + additions.size <= 1000) { "This local capture has reached 1,000 messages. Start a separate capture." }
        return SessionMerge(session.copy(lastObservedAt = observedAt,
            turns = (old + additions.map { it.first }).sortedBy { it.sequence }), additions, messages.size - additions.size)
    }
}
