package dev.sherry.capture.core

import java.io.File
import java.util.UUID
import kotlin.test.*

class NativeSessionTest {
    private val now = "2026-10-02T06:00:00Z"
    private val later = "2026-10-02T06:01:00Z"
    private fun session() = NativeSession(UUID.randomUUID().toString(), now, now)
    private val turns = listOf(ParsedMessage("user", "First question"), ParsedMessage("assistant", "First answer"),
        ParsedMessage("user", "Second question"), ParsedMessage("assistant", "Second answer"))

    @Test fun `three then four messages yield four unique events with earlier message prepended`() {
        val first = NativeReconciler.merge(session(), turns.drop(1), now)
        val second = NativeReconciler.merge(first.session, turns, later)
        assertEquals(3, second.duplicates)
        assertEquals(1, second.additions.size)
        assertEquals(4, second.session.turns.size)
        assertEquals(first.session.turns.map { it.id }, second.session.turns.drop(1).map { it.id })
        assertTrue(second.additions.single().first.sequence < first.session.turns.first().sequence)
        val payloads = (first.additions + second.additions).map { (turn, message) ->
            val capture = CaptureFactory.nativeTurn(first.session, turn, message, UUID.randomUUID().toString(), ChatGptParser.VERIFIED_VERSION, now)
            CaptureFactory.freeze(capture, "7c895c18-05e4-4f96-9148-37ad93b2a789", "android-test-device").payload!!
        }
        File("build/session-contract-fixtures.json").writeText(payloads.joinToString(",", "[", "]"))
    }
    @Test fun `repeat and contained reads add no duplicates after serialized ledger restart`() {
        val first = NativeReconciler.merge(session(), turns, now)
        val restored = CaptureJson.decodeFromString(NativeSession.serializer(), CaptureJson.encodeToString(NativeSession.serializer(), first.session))
        assertEquals(0, NativeReconciler.merge(restored, turns, later).additions.size)
        assertEquals(0, NativeReconciler.merge(restored, turns.takeLast(2), later).additions.size)
    }
    @Test fun `new appended turns keep existing identities`() {
        val first = NativeReconciler.merge(session(), turns.take(3), now)
        val second = NativeReconciler.merge(first.session, turns.drop(1), later)
        assertEquals(1, second.additions.size)
        assertEquals(turns.last(), second.additions.single().second)
        assertEquals(first.session.turns, second.session.turns.take(3))
    }
    @Test fun `same text in separate sessions never establishes shared identity`() {
        val a = NativeReconciler.merge(session(), turns, now)
        val b = NativeReconciler.merge(session(), turns, now)
        assertNotEquals(a.session.id, b.session.id)
        assertTrue(a.session.turns.none { old -> b.session.turns.any { it.id == old.id } })
    }
    @Test fun `repeated text at different positions stays distinct and ambiguous overlaps stop`() {
        val repeated = turns.take(2) + turns.take(2)
        val first = NativeReconciler.merge(session(), repeated, now)
        assertEquals(4, first.session.turns.map { it.id }.distinct().size)
        assertFailsWith<IllegalArgumentException> { NativeReconciler.merge(first.session, turns.take(2), later) }
    }
    @Test fun `edits gaps single anchors and clipping do not silently merge`() {
        val first = NativeReconciler.merge(session(), turns, now)
        for (read in listOf(listOf(turns.last()), listOf(ParsedMessage("user", "Different chat")),
            turns.mapIndexed { i, t -> if (i == 1) t.copy(text = "Edited answer") else t },
            turns.take(2).map { it.copy(completeness = "possibly_clipped") })) {
            assertFailsWith<IllegalArgumentException> { NativeReconciler.merge(first.session, read, later) }
        }
    }
    @Test fun `continuous foreground read may append from one exact final anchor only`() {
        val first = NativeReconciler.merge(session(), turns.take(1), now)
        val next = NativeReconciler.merge(first.session, turns.take(2), later, allowSingleTrailingAnchor = true)
        assertEquals(1, next.additions.size)
        assertEquals(turns[1], next.additions.single().second)
        assertEquals(first.session.turns.single().id, next.session.turns.first().id)
        assertEquals(0, NativeReconciler.merge(first.session, turns.take(1), later,
            allowSingleTrailingAnchor = true).additions.size)
        assertFailsWith<IllegalArgumentException> {
            NativeReconciler.merge(first.session, turns.take(2), later)
        }
        val three = NativeReconciler.merge(session(), turns.take(3), now)
        assertFailsWith<IllegalArgumentException> {
            NativeReconciler.merge(three.session, listOf(turns[0], ParsedMessage("assistant", "Earlier reply")), later,
                allowSingleTrailingAnchor = true)
        }
    }
    @Test fun `continuous append is anchored to the saved tail even if the initial pair repeats`() {
        val first=NativeReconciler.merge(session(),turns,now)
        val appended=turns+turns.take(2)
        val result=NativeReconciler.merge(first.session,appended,later,allowSingleTrailingAnchor=true)
        assertEquals(2,result.additions.size)
        assertEquals(first.session.turns,result.session.turns.take(4))
        assertFailsWith<IllegalArgumentException>{NativeReconciler.merge(first.session,appended,later)}
    }
    @Test fun `native evidence carries unknown source time and exact immutable retry body`() {
        val merged = NativeReconciler.merge(session(), turns, now)
        val capture = CaptureFactory.nativeTurn(merged.session, merged.additions[0].first, turns[0], UUID.randomUUID().toString(), ChatGptParser.VERIFIED_VERSION, now)
        val frozen = CaptureFactory.freeze(capture, "7c895c18-05e4-4f96-9148-37ad93b2a789", "test-device")
        val batch = CaptureJson.decodeFromString<CaptureBatch>(frozen.payload!!)
        assertEquals("observed", batch.events.single().captureEvidence!!.timestampBasis)
        assertEquals("session_sequence", batch.events.single().captureEvidence!!.orderBasis)
        assertNull(batch.events.single().messageTimestamp)
        assertNull(batch.events.single().providerMessageId)
        assertEquals(frozen.payload, CaptureFactory.freeze(frozen, batch.workspaceId, "changed-device").payload)
    }
    @Test fun `server evidence capability is explicit and fails closed`() {
        assertTrue(supportsCaptureEvidence("""{"ok":true,"captureEvidenceVersion":1}"""))
        for (body in listOf(null, "bad", "{}", """{"ok":true}""", """{"ok":false,"captureEvidenceVersion":1}""")) assertFalse(supportsCaptureEvidence(body))
    }
}
